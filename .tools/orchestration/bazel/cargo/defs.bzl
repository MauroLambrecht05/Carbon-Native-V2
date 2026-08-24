"""`cargo_binary` and `cargo_test` — Bazel targets that build Rust through Cargo.

WHY BAZEL DRIVES CARGO RATHER THAN REPLACING IT
-----------------------------------------------
`rules_rust` + `crate_universe` can build a Rust graph natively, and for a tree
of pure-Rust crates that is the better answer: real per-crate caching, real
sandboxing, no second build system.

This graph is not that. 123 of the runtime's transitive dependencies run build
scripts, and the difficult ones are not incidental:

  * rquickjs-sys  compiles the QuickJS C sources and runs bindgen
  * ring          assembles per-target .S files
  * ash / naga    Vulkan loaders behind wgpu
  * icu_*_data    generated data blobs

Making all 123 work under crate_universe on Windows, macOS and Linux is a
project in itself, and the payoff is caching for a graph Cargo already caches
well. Worse, the runtime needs the MSVC linker on Windows regardless, so full
hermeticity is not reachable even if every build script were ported.

So Bazel owns the *graph* — one command, one dependency tree, targets other
rules depend on — and Cargo stays the compiler driver. Exactly the arrangement
`//.tools/orchestration/bazel/bun` uses for TypeScript, and for the same reason:
the tool that understands the ecosystem keeps doing that job.

The escape hatch stays open. Every target here names a package and a feature
set, which is what a `rust_library` would need too, so switching to native
rules later is a rule swap rather than a re-architecture.

WHERE CARGO COMES FROM
----------------------
Located on the host at run time, not downloaded into runfiles — which is the one
real difference from the Bun toolchain, where the binary IS fetched and pinned.

Rust cannot be made hermetic here without also vendoring a C toolchain (see the
build scripts above), so a downloaded rustc would buy version pinning and
nothing else. Version pinning is instead checked against
`.config/dependencies.json`, which is the agreement `contracts/toolchain`
declares, and the launcher fails loudly when the host disagrees.

Search order: $CARGO_HOME/bin, ~/.cargo/bin, then PATH. The first two come first
because rustup installs there and does NOT always put itself on PATH — this
machine is an example, where cargo 1.86.0 is installed and invisible to a bare
`cargo --version` in a fresh shell.

WHAT THESE DO NOT DO
--------------------
They do not sandbox the build. The launcher chdirs to BUILD_WORKSPACE_DIRECTORY
and runs cargo against the real tree, so Cargo's own target/ directory does the
incremental work. Bazel does not see individual .rlib outputs and cannot cache
below the level of "this target ran".

That is a deliberate compromise, documented rather than hidden. The alternative
is the crate_universe project described above.
"""

load("@carbon_cargo//:defs.bzl", "CARGO_PATH", "WORKSPACE_ROOT")

_MANIFEST = ".tools/orchestration/bazel/cargo/Cargo.toml"

# Cargo settings that would otherwise need a .cargo/config.toml in the
# repository root.
#
# Cargo finds .cargo/config.toml by walking up from the CURRENT DIRECTORY, so it
# cannot live under .config/ like everything else — it would have to sit in the
# root. Every one of these keys has an environment equivalent (verified: feeding
# CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS a bad value makes cargo reject it,
# which proves it is read), so the launcher sets them and the root stays clean.
#
#   CARGO_TARGET_DIR      target/ beside this directory's Cargo.toml, which is
#                         Cargo's own default. It was .tools/.build/rust, a
#                         directory the root README never declared and that
#                         nothing but this line pointed at.
#                         NOT at the workspace root: the root holds Bazel's
#                         files and the tiers, and generated output is neither.
#   CARGO_INCREMENTAL     off: every shipped binary is lto = "fat", which
#                         incremental defeats, and release builds are the ones
#                         that get measured
#   ..._RUSTFLAGS         strip the checkout path out of panics, backtraces and
#                         debug info, so binaries are reproducible across
#                         machines and do not leak the builder's home directory
#   ..._INCOMPATIBLE_..   load-bearing. Without it the resolver takes the newest
#                         release of everything and the build dies on transitive
#                         crates that bumped their MSRV past ours — which is
#                         exactly what happened in V1 the first time these
#                         crates shared one lockfile.
#   RUSTUP_TOOLCHAIN     which toolchain rustup hands the `cargo` shim. This is
#                        the env equivalent of a rust-toolchain.toml, and it is
#                        here for the same reason as the keys above: rustup
#                        discovers that file by walking up from the current
#                        directory, so it would have to sit at the workspace
#                        root, and the root is Bazel's.
#
#                        Not decorative. `rust-version = "1.88"` in
#                        .tools/orchestration/bazel/cargo/Cargo.toml is an MSRV *assertion* — it
#                        makes Cargo complain about a dependency needing more,
#                        but it does not select a toolchain. Without this, the
#                        build silently uses whatever `rustup default` happens
#                        to be, which is how a tree that declares 1.86 ends up
#                        only ever compiled on something far newer.
#
#                        That is exactly what was happening. Pinning 1.86 made
#                        `cargo build --workspace` fail with 'wgpu@27.0.1
#                        requires rustc 1.88' — the declared version had never
#                        been the one in use.
_CARGO_ENV = {
    "CARGO_TARGET_DIR": ".tools/orchestration/bazel/cargo/target",
    "CARGO_INCREMENTAL": "0",
    "CARGO_BUILD_RUSTFLAGS": "--remap-path-prefix=.=carbon-native",
    "CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS": "fallback",
    # Fully qualified, not "1.88": rustup treats a bare channel spec as a
    # DIFFERENT toolchain identity from the exact version CI actually
    # installs (`rustup toolchain install 1.88.0 --component rustfmt`
    # creates "1.88.0-<host>"), so "1.88" here made rustup silently
    # auto-install a separate, component-less "1.88-<host>" the moment
    # cargo/rustfmt ran — confirmed on a real CI run: "error: 'cargo-fmt'
    # is not installed for the toolchain '1.88-x86_64-unknown-linux-gnu'"
    # right after a green "Run dtolnay/rust-toolchain@1.88" install step.
    "RUSTUP_TOOLCHAIN": "1.88.0",
}

# Locating cargo is identical on both platforms in intent, so the two launchers
# differ only in shell syntax. Keep them in step.
_SH_LAUNCHER = """\
#!/usr/bin/env bash
set -euo pipefail

find_cargo() {{
  # Resolved at fetch time by @carbon_cargo, where the real environment is
  # visible. Empty when the host had no cargo when the repo was last fetched.
  if [ -n "{cargo_path}" ] && [ -x "{cargo_path}" ]; then
    echo "{cargo_path}"; return 0
  fi
  # rustup installs here and does not always export it — prefer it over PATH.
  if [ -n "${{CARGO_HOME:-}}" ] && [ -x "$CARGO_HOME/bin/cargo" ]; then
    echo "$CARGO_HOME/bin/cargo"; return 0
  fi
  if [ -x "$HOME/.cargo/bin/cargo" ]; then
    echo "$HOME/.cargo/bin/cargo"; return 0
  fi
  if command -v cargo >/dev/null 2>&1; then
    command -v cargo; return 0
  fi
  return 1
}}

CARGO="$(find_cargo || true)"
if [ -z "$CARGO" ]; then
  echo "error: cargo not found." >&2
  echo "  looked in: \\$CARGO_HOME/bin, ~/.cargo/bin, \\$PATH" >&2
  echo "  install with: https://rustup.rs" >&2
  echo "  the pinned version is in .config/dependencies.json" >&2
  exit 1
fi

# `bazel run` gives us the source tree; `bazel test` does not, and leaves the
# working directory in the execroot where a relative --manifest-path resolves
# against nothing. WORKSPACE_ROOT is the fetch-time fallback.
if [ -n "${{BUILD_WORKSPACE_DIRECTORY:-}}" ]; then
  cd "$BUILD_WORKSPACE_DIRECTORY"
elif [ -d "{workspace_root}" ]; then
  cd "{workspace_root}"
fi

{env}
exec "$CARGO" {subcommand} --manifest-path {manifest} {args} "$@"
"""

_BAT_LAUNCHER = """\
@echo off
setlocal enabledelayedexpansion

rem Chained `if` rather than nested `if (...)` blocks. cmd.exe parses a .bat
rem line by line as it executes, and a block whose parentheses do not balance
rem fails silently — no output, bare non-zero exit, nothing in the test log.
rem Flat chains cannot get out of balance.
rem
rem The first candidate is resolved at fetch time by @carbon_cargo. That is the
rem one that matters under `bazel test`: Bazel scrubs the environment, so the
rem %CARGO_HOME% / %USERPROFILE% lookups below see nothing there.
set "CARGO="
if exist "{cargo_path_win}" set "CARGO={cargo_path_win}"
if "!CARGO!"=="" if not "%CARGO_HOME%"=="" if exist "%CARGO_HOME%\\bin\\cargo.exe" set "CARGO=%CARGO_HOME%\\bin\\cargo.exe"
if "!CARGO!"=="" if not "%USERPROFILE%"=="" if exist "%USERPROFILE%\\.cargo\\bin\\cargo.exe" set "CARGO=%USERPROFILE%\\.cargo\\bin\\cargo.exe"
if "!CARGO!"=="" for %%i in (cargo.exe) do set "CARGO=%%~$PATH:i"
if "!CARGO!"=="" goto nocargo

rem `bazel run` gives us the source tree; `bazel test` does not, and leaves the
rem working directory in the execroot. {workspace_root_win} is the fetch-time fallback.
if not "%BUILD_WORKSPACE_DIRECTORY%"=="" cd /d "%BUILD_WORKSPACE_DIRECTORY%"
if "%BUILD_WORKSPACE_DIRECTORY%"=="" if exist "{workspace_root_win}" cd /d "{workspace_root_win}"

{env}
"!CARGO!" {subcommand} --manifest-path {manifest} {args} %*
exit /b %ERRORLEVEL%

:nocargo
echo error: cargo not found. 1>&2
echo   looked in: the fetch-time path, %%CARGO_HOME%%\\bin, %%USERPROFILE%%\\.cargo\\bin, %%PATH%% 1>&2
echo   install with: https://rustup.rs 1>&2
echo   the pinned version is in .config/dependencies.json 1>&2
exit /b 1
"""

def _cargo_args(ctx):
    """The argv shared by build and test: which package, which features."""
    if not ctx.attr.package:
        # Workspace-wide targets (fmt, clippy) name no package; they pass their
        # whole argv through `extra_args` instead.
        return []

    args = ["-p", ctx.attr.package]

    if ctx.attr.bin:
        args += ["--bin", ctx.attr.bin]

    # --no-default-features is not optional for this workspace. Cargo stacks
    # --features ON TOP of defaults rather than replacing them, so a bare
    # `--features blitz` would still compile mini's entire stack. See the
    # comment at the top of the runtime's Cargo.toml.
    if ctx.attr.crate_features:
        args += ["--no-default-features", "--features", ",".join(ctx.attr.crate_features)]

    if ctx.attr.profile:
        args += ["--profile", ctx.attr.profile]

    return args

def _launcher(ctx, subcommand, extra_args = []):
    args = " ".join(_cargo_args(ctx) + extra_args)

    if ctx.attr.is_windows:
        launcher = ctx.actions.declare_file(ctx.label.name + ".bat")
        env = "\n".join([
            'set "%s=%s"' % (k, v)
            for k, v in sorted(_CARGO_ENV.items())
        ])
        content = _BAT_LAUNCHER.format(
            subcommand = subcommand,
            manifest = _MANIFEST.replace("/", "\\"),
            args = args,
            env = env,
            cargo_path_win = CARGO_PATH.replace("/", "\\"),
            workspace_root_win = WORKSPACE_ROOT.replace("/", "\\"),
        )
        # cmd.exe parses a .bat line by line as it executes; with LF endings it
        # chews through multi-line `if (...)` blocks. Same trap as the Bun rule.
        content = content.replace("\n", "\r\n")
    else:
        launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
        env = "\n".join([
            'export %s="%s"' % (k, v)
            for k, v in sorted(_CARGO_ENV.items())
        ])
        content = _SH_LAUNCHER.format(
            subcommand = subcommand,
            manifest = _MANIFEST,
            args = args,
            env = env,
            cargo_path = CARGO_PATH,
            workspace_root = WORKSPACE_ROOT,
        )

    ctx.actions.write(launcher, content, is_executable = True)

    runfiles = ctx.runfiles(files = ctx.files.srcs + ctx.files.data)
    for dep in ctx.attr.deps:
        runfiles = runfiles.merge(dep[DefaultInfo].default_runfiles)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

_COMMON_ATTRS = {
    "package": attr.string(
        doc = "Cargo package name, as it appears in its Cargo.toml [package]. " +
              "Omitted by workspace-wide targets like fmt and clippy.",
    ),
    "extra_args": attr.string_list(
        doc = "Raw argv appended after the subcommand. Used by the " +
              "workspace-wide quality targets, which select crates with " +
              "--workspace/--exclude rather than -p.",
    ),
    "bin": attr.string(
        doc = "Which [[bin]] target. Omit for a library, or for the only bin.",
    ),
    # NOT "features": that is a built-in Bazel attribute (the C++ toolchain
    # feature system) and cannot be overridden. rules_rust calls it
    # crate_features for the same reason.
    "crate_features": attr.string_list(
        doc = "Cargo features. Implies --no-default-features; see _cargo_args.",
    ),
    "profile": attr.string(
        doc = "Cargo profile: dev, release, or dist. Omit for dev.",
    ),
    "srcs": attr.label_list(
        allow_files = True,
        doc = "Sources, so Bazel re-runs the target when they change.",
    ),
    "deps": attr.label_list(doc = "Other targets whose runfiles are needed."),
    "data": attr.label_list(allow_files = True),
    "is_windows": attr.bool(mandatory = True),
}

_cargo_binary = rule(
    implementation = lambda ctx: _launcher(ctx, "build"),
    attrs = _COMMON_ATTRS,
    executable = True,
)

_cargo_test = rule(
    implementation = lambda ctx: _launcher(ctx, "test"),
    attrs = _COMMON_ATTRS,
    test = True,
)

# Quality gates. Separate rules from cargo_test only so a BUILD file reads
# honestly — the launcher is identical, and both are `bazel test` targets so
# `bazel test //...` gates on them the way CI needs.
_cargo_fmt_test = rule(
    implementation = lambda ctx: _launcher(ctx, "fmt", ctx.attr.extra_args),
    attrs = _COMMON_ATTRS,
    test = True,
)

_cargo_clippy_test = rule(
    implementation = lambda ctx: _launcher(ctx, "clippy", ctx.attr.extra_args),
    attrs = _COMMON_ATTRS,
    test = True,
)

_cargo_fmt_fix = rule(
    implementation = lambda ctx: _launcher(ctx, "fmt", ctx.attr.extra_args),
    attrs = _COMMON_ATTRS,
    executable = True,
)

def cargo_binary(name, **kwargs):
    """A Rust binary, built by Cargo, runnable with `bazel run`."""
    _cargo_binary(
        name = name,
        is_windows = select({
            "@platforms//os:windows": True,
            "//conditions:default": False,
        }),
        **kwargs
    )

def cargo_library(name, **kwargs):
    """A Rust library, built by Cargo.

    The same rule as cargo_binary — `cargo build -p <pkg>` builds whatever
    targets the package declares. It exists under its own name so a BUILD file
    reads honestly: a crate with no [[bin]] should not be declared as a binary
    just because the underlying command is identical.
    """
    _cargo_binary(
        name = name,
        is_windows = select({
            "@platforms//os:windows": True,
            "//conditions:default": False,
        }),
        **kwargs
    )

def cargo_test(name, **kwargs):
    """`cargo test` for one package, as a Bazel test target.

    Untagged, this failed for real on macOS CI: every cargo_test target
    shares one CARGO_TARGET_DIR (this file's own docstring explains why —
    cargo runs against the real tree, not a declared Bazel input set), so
    they all lock the same target/debug/.cargo-lock, and Bazel's
    darwin-sandbox denies the flock() syscall Cargo needs for that —
    "failed to open: .../.cargo-lock, Caused by: Operation not permitted
    (os error 1)", immediately, on every cargo_test target at once.
    _UNCACHEABLE's no-sandbox is the fix (same reasoning already applied
    to cargo_fmt_test/cargo_clippy_test below, just never extended here);
    no-cache/external ride along because the staleness problem their own
    comment describes — a real-tree run Bazel cannot see changed, cached
    PASS forever — applies here for the identical reason, not because
    this test failed on it.
    """
    _cargo_test(
        name = name,
        is_windows = select({
            "@platforms//os:windows": True,
            "//conditions:default": False,
        }),
        tags = _with_tags(kwargs),
        **kwargs
    )

# ── Workspace-wide quality gates ────────────────────────────────────────────
# These replace what a task runner would otherwise own. Bazel is the entrypoint
# in this workspace, so `bazel test //...` has to be able to fail on formatting
# and lints — not just on unit tests.
#
# They select crates with --workspace/--exclude rather than -p, which is why the
# rules accept `extra_args` and no `package`.

_WINDOWS = select({
    "@platforms//os:windows": True,
    "//conditions:default": False,
})

# These run cargo against the real source tree rather than a declared input set,
# so Bazel has no way to know the tree changed and will serve a cached PASS
# forever. Verified the hard way: without `no-cache`, `bazel test //:fmt_test`
# reported "(cached) PASSED" on a file that had just been deliberately
# misformatted. A gate that cannot fail is worse than no gate.
#
# Same reasoning and same tags as //.tools/orchestration/bazel/checks.
_UNCACHEABLE = ["no-sandbox", "no-cache", "external"]

def _with_tags(kwargs):
    tags = kwargs.pop("tags", [])
    return tags + [t for t in _UNCACHEABLE if t not in tags]

# carbon-gpu-canvas is excluded from clippy for the same reason it is excluded
# from `bazel test`: its wgpu stack needs a real GPU adapter. Lint it explicitly
# on a machine that has one.
_LINT_SCOPE = ["--workspace", "--exclude", "carbon-gpu-canvas"]

def cargo_fmt_test(name, **kwargs):
    """Fails if any file in the workspace is not rustfmt-clean."""
    _cargo_fmt_test(
        name = name,
        extra_args = ["--all", "--", "--check"],
        is_windows = _WINDOWS,
        tags = _with_tags(kwargs),
        **kwargs
    )

def cargo_fmt(name, **kwargs):
    """`bazel run` this to reformat the workspace in place."""
    _cargo_fmt_fix(
        name = name,
        extra_args = ["--all"],
        is_windows = _WINDOWS,
        tags = _with_tags(kwargs),
        **kwargs
    )

def cargo_clippy_test(name, **kwargs):
    """Clippy with -D warnings. The allow-list is [workspace.lints.clippy]."""
    _cargo_clippy_test(
        name = name,
        extra_args = _LINT_SCOPE + ["--all-targets", "--", "-D", "warnings"],
        is_windows = _WINDOWS,
        tags = _with_tags(kwargs),
        **kwargs
    )
