"""`bun_binary` and `bun_test` — Bazel targets that run TypeScript through Bun.

WHAT THESE DO NOT DO
--------------------
These do not sandbox or hermetically build the TypeScript. The launcher chdirs
to BUILD_WORKSPACE_DIRECTORY (the real source tree) and runs bun there. That is
a deliberate, documented compromise, not an oversight:

  * Bun resolves `node_modules` by walking UP from each importing file, and it
    resolves the @carbon/* aliases from the tsconfig.json nearest that file.
    Both mechanisms need the real directory layout. Reproducing them inside a
    runfiles tree means materialising node_modules there, which needs npm rules
    this workspace deliberately does not have.
  * The dev loop's value is its speed. Copying the tree per invocation would
    trade the thing the project exists to be good at for a purity it does not
    currently get anything from.

So Bazel is the *entrypoint* — one command, one dependency graph, targets other
rules can depend on — while Bun stays the runtime. `bazel run
//products/carbon-cli:carbon -- dev` and `bun products/carbon-cli/src/main.ts
dev` do the same work.

To make this genuinely hermetic later, node_modules has to become a Bazel
input. That is the one job rules_js does well; it would mean adding
aspect_rules_js back purely for `npm_translate_lock`, fed a lockfile it
understands (pnpm/npm/yarn — not bun.lock).
"""

_TOOLCHAIN_TYPE = "//.tools/orchestration/bazel/bun:toolchain_type"

# Both launchers look for bun in the runfiles *directory* first, then fall back
# to the runfiles MANIFEST. The fallback is not optional on Windows: Bazel does
# not materialise symlinks for external repositories there unless
# --enable_runfiles is on (which itself needs Developer Mode or admin), so the
# directory contains only _main/ and bun is reachable only through MANIFEST.
_BAT_LAUNCHER = """\
@echo off
setlocal enabledelayedexpansion
if "%RUNFILES_DIR%"=="" set "RUNFILES_DIR=%~dp0{name}.bat.runfiles"
set "BUN_EXE=%RUNFILES_DIR%\\{bun_path_win}"
if not exist "!BUN_EXE!" (
  if exist "%RUNFILES_DIR%\\MANIFEST" (
    for /f "tokens=1,*" %%a in ('findstr /b /l /c:"{bun_path} " "%RUNFILES_DIR%\\MANIFEST"') do (
      set "BUN_EXE=%%b"
    )
    set "BUN_EXE=!BUN_EXE:/=\\!"
  )
)
if not exist "!BUN_EXE!" (
  echo error: could not locate the bun executable in runfiles 1>&2
  exit /b 1
)
rem `bazel run` sets BUILD_WORKSPACE_DIRECTORY, so we execute against the real
rem source tree. `bazel test` does not set it, and on Windows the runfiles
rem *directory* is never materialised (no symlinks without Developer Mode) —
rem only MANIFEST exists. So the entry is resolved through MANIFEST to an
rem absolute path, which also lets bun walk up to node_modules.
rem The "./" prefix is only correct for the workspace-relative form; the
rem MANIFEST yields an absolute path, which must be passed as-is.
set "ENTRY={entry_prefix}{entry}"
set "PRELOAD={preload}"
if not "%BUILD_WORKSPACE_DIRECTORY%"=="" (
  cd /d "%BUILD_WORKSPACE_DIRECTORY%"
) else (
  if exist "%RUNFILES_DIR%\\MANIFEST" (
    for /f "tokens=1,*" %%a in ('findstr /b /l /c:"{entry_rlocation} " "%RUNFILES_DIR%\\MANIFEST"') do (
      set "ENTRY=%%b"
    )
    rem The preload needs the same MANIFEST resolution as the entry, for the
    rem same reason: a workspace-relative path is meaningless once bazel test
    rem has moved us out of the source tree.
    if not "!PRELOAD!"=="" (
      for /f "tokens=1,*" %%a in ('findstr /b /l /c:"{preload_rlocation} " "%RUNFILES_DIR%\\MANIFEST"') do (
        set "PRELOAD=%%b"
      )
    )
  )
)
rem Same defensive check as the .sh launcher: a resolved-but-wrong PRELOAD
rem must not hard-fail the run — see its comment for why this exists.
if not "!PRELOAD!"=="" if not exist "!PRELOAD!" set "PRELOAD="
set "PRELOAD_ARG="
if not "!PRELOAD!"=="" set "PRELOAD_ARG=--preload "!PRELOAD!""
"!BUN_EXE!" {subcommand}!PRELOAD_ARG! "!ENTRY!" {trailing} %*
"""

_SH_LAUNCHER = """\
#!/usr/bin/env bash
set -euo pipefail
RUNFILES_DIR="${{RUNFILES_DIR:-$0.runfiles}}"
BUN_EXE="$RUNFILES_DIR/{bun_path}"
if [ ! -x "$BUN_EXE" ] && [ -f "$RUNFILES_DIR/MANIFEST" ]; then
  BUN_EXE="$(grep -m1 "^{bun_path} " "$RUNFILES_DIR/MANIFEST" | cut -d' ' -f2-)"
fi
if [ ! -x "$BUN_EXE" ]; then
  echo "error: could not locate the bun executable in runfiles" >&2
  exit 1
fi
# See the note in the .bat launcher: `bazel run` gives us the source tree;
# under `bazel test` the entry is resolved through MANIFEST instead.
# The "./" prefix is only correct for the workspace-relative form; the
# MANIFEST yields an absolute path, which must be passed as-is.
ENTRY="{entry_prefix}{entry}"
PRELOAD="{preload}"
if [ -n "${{BUILD_WORKSPACE_DIRECTORY:-}}" ]; then
  cd "$BUILD_WORKSPACE_DIRECTORY"
elif [ -f "$RUNFILES_DIR/MANIFEST" ]; then
  ENTRY="$(grep -m1 "^{entry_rlocation} " "$RUNFILES_DIR/MANIFEST" | cut -d' ' -f2-)"
  # The preload needs the same treatment as the entry, and for the same reason:
  # a workspace-relative path is meaningless once bazel test has moved us out of
  # the source tree. Resolved through MANIFEST to an absolute path.
  if [ -n "$PRELOAD" ]; then
    PRELOAD="$(grep -m1 "^{preload_rlocation} " "$RUNFILES_DIR/MANIFEST" | cut -d' ' -f2-)"
  fi
else
  cd "$RUNFILES_DIR/{workspace}"
fi
# Confirmed on a real `bazel test` run (Linux, processwrapper-sandbox): this
# branch's cd target does not consistently place the preload's short_path
# where a plain relative reference finds it, even when the same relative
# form correctly resolves ENTRY seconds later — bun then hard-errors with
# "preload not found", which is exactly the failure mode the comment above
# already said skipping was supposed to prevent. That fallback was never
# actually implemented; this is it: check the resolved path is a real file
# before ever passing --preload, on every branch, not just this one.
if [ -n "$PRELOAD" ] && [ ! -f "$PRELOAD" ]; then PRELOAD=""; fi
PRELOAD_ARG=""
if [ -n "$PRELOAD" ]; then PRELOAD_ARG="--preload"; fi
exec "$BUN_EXE" {subcommand}${{PRELOAD_ARG:+$PRELOAD_ARG "$PRELOAD"}} "$ENTRY" {trailing} "$@"
"""

def _rlocation(ctx, file):
    """Path of `file` relative to the runfiles root.

    short_path is NOT that path for external repositories: it comes back as
    `../<repo>/<path>` because it is expressed relative to the main workspace's
    directory inside runfiles. The runfiles root itself contains one directory
    per repository, so the `../` has to be stripped rather than followed —
    following it lands one level above the tree and yields "The system cannot
    find the path specified".
    """
    if file.short_path.startswith("../"):
        return file.short_path[3:]
    return ctx.workspace_name + "/" + file.short_path

def _launcher_impl(ctx, subcommand, entry_prefix = "", trailing = "", extra_files = [], preload = None):
    bun = ctx.toolchains[_TOOLCHAIN_TYPE].buninfo.bun

    # Two forms of the entry are baked in, and the launcher picks at runtime:
    #   short_path      — workspace-relative, used after chdir under `bazel run`
    #   rlocation       — MANIFEST key, used to recover an absolute path under
    #                     `bazel test`, where no source tree is available
    entry = ctx.file.entry.short_path
    entry_rlocation = _rlocation(ctx, ctx.file.entry)
    bun_path = _rlocation(ctx, bun)
    # Empty strings when there is no preload; both launchers treat "" as absent.
    preload_path = preload.short_path if preload else ""
    preload_rlocation = _rlocation(ctx, preload) if preload else ""

    if ctx.attr.is_windows:
        launcher = ctx.actions.declare_file(ctx.label.name + ".bat")
        content = _BAT_LAUNCHER.format(
            name = ctx.label.name,
            bun_path = bun_path,
            bun_path_win = bun_path.replace("/", "\\"),
            entry = entry,
            entry_rlocation = entry_rlocation,
            entry_prefix = entry_prefix,
            preload = preload_path,
            preload_rlocation = preload_rlocation,
            subcommand = subcommand,
            trailing = trailing,
            workspace = ctx.workspace_name,
        )
    else:
        launcher = ctx.actions.declare_file(ctx.label.name + ".sh")
        content = _SH_LAUNCHER.format(
            bun_path = bun_path,
            entry = entry,
            entry_rlocation = entry_rlocation,
            entry_prefix = entry_prefix,
            preload = preload_path,
            preload_rlocation = preload_rlocation,
            subcommand = subcommand,
            trailing = trailing,
            workspace = ctx.workspace_name,
        )

    # cmd.exe requires CRLF. With LF-only endings it mis-parses multi-line
    # `if (...)` blocks — the observed symptom is nonsense like "'tlocal' is
    # not recognized", cmd having chewed through the line boundary.
    if ctx.attr.is_windows:
        content = content.replace("\n", "\r\n")

    ctx.actions.write(launcher, content, is_executable = True)

    runfiles = ctx.runfiles(
        files = [bun, ctx.file.entry] + ctx.files.srcs + ctx.files.data + extra_files,
    )
    for dep in ctx.attr.deps:
        runfiles = runfiles.merge(dep[DefaultInfo].default_runfiles)

    return [DefaultInfo(executable = launcher, runfiles = runfiles)]

def _bun_binary_impl(ctx):
    return _launcher_impl(ctx, "")

def _bun_test_impl(ctx):
    # `--preload` is passed on the command line rather than left to
    # .config/bunfig.toml. Under `bazel test` the working directory is the
    # execroot, not the workspace root, so bun's upward search for a bunfig
    # never reaches .config/ and any [test] preload there is silently skipped.
    # An explicit flag is the only form that survives the sandbox.
    #
    # The file makes runs deterministic (NO_COLOR, TZ=UTC, LC_ALL=C) — see
    # .tools/automation/testing/src/preload.ts. Skipping it does not fail a
    # test, it just makes failures depend on the machine, which is worse.
    extra = [ctx.file.preload] if ctx.file.preload else []
    return _launcher_impl(
        ctx,
        "test ",
        entry_prefix = "./",
        extra_files = extra,
        preload = ctx.file.preload,
    )

def _bun_compile_impl(ctx):
    """`bun build --compile` — bundles the program AND the Bun runtime into one
    executable, so it runs on machines with no Bun installed.

    This replaces a hand-written build-cli.ts that used to sit inside the
    product. Build tooling does not belong in a product directory, and the
    flags below are configuration, not a program — they read better as rule
    attributes than as an array in a script nobody runs twice.
    """
    flags = ["build", "--compile"]
    if ctx.attr.minify:
        flags.append("--minify")
    if ctx.attr.sourcemap:
        flags.append("--sourcemap=" + ctx.attr.sourcemap)
    for external in ctx.attr.externals:
        flags.extend(["--external", external])

    # The output path is workspace-relative because the launcher chdirs to
    # BUILD_WORKSPACE_DIRECTORY: the artifact lands in the source tree, not in
    # bazel-out. It cannot be a declared Bazel output — `bun build` needs
    # node_modules, which is not a Bazel input. See the module docstring.
    out = ctx.attr.out
    if not out:
        out = ctx.label.package + "/dist/" + ctx.label.name

    return _launcher_impl(
        ctx,
        subcommand = " ".join(flags) + " ",
        trailing = '--outfile "%s"' % out,
    )

_COMMON_ATTRS = {
    "entry": attr.label(
        allow_single_file = True,
        mandatory = True,
        doc = "The .ts entrypoint bun executes.",
    ),
    "srcs": attr.label_list(
        allow_files = True,
        doc = "Other sources this target needs present.",
    ),
    "deps": attr.label_list(
        doc = "Other targets whose runfiles are needed.",
    ),
    "data": attr.label_list(
        allow_files = True,
        doc = "Runtime data files.",
    ),
    # Set by the macros below via select(); the launcher shape differs per OS.
    "is_windows": attr.bool(default = False),
}

_bun_binary = rule(
    implementation = _bun_binary_impl,
    executable = True,
    attrs = _COMMON_ATTRS,
    toolchains = [_TOOLCHAIN_TYPE],
)

_bun_test = rule(
    implementation = _bun_test_impl,
    test = True,
    attrs = dict(_COMMON_ATTRS, **{
        "preload": attr.label(
            allow_single_file = True,
            default = "//.tools/automation/testing:preload",
            doc = "Module bun evaluates before every suite. Defaults to the " +
                  "workspace determinism preload; set to None to opt out.",
        ),
    }),
    toolchains = [_TOOLCHAIN_TYPE],
)

_bun_compile = rule(
    implementation = _bun_compile_impl,
    executable = True,
    attrs = dict(_COMMON_ATTRS, **{
        "out": attr.string(
            doc = "Workspace-relative output path. Defaults to <package>/dist/<name>.",
        ),
        "minify": attr.bool(
            default = True,
            doc = "Shaves ~4 MB off the binary and slightly improves startup.",
        ),
        "sourcemap": attr.string(
            default = "external",
            doc = "Passed to --sourcemap. Keeps a .map beside the binary for stack traces.",
        ),
        "externals": attr.string_list(
            doc = "Modules to leave out of the bundle (--external).",
        ),
    }),
    toolchains = [_TOOLCHAIN_TYPE],
)

_IS_WINDOWS = select({
    "@platforms//os:windows": True,
    "//conditions:default": False,
})

def bun_binary(name, **kwargs):
    """A runnable Bun program. See module docstring for the hermeticity note."""
    _bun_binary(name = name, is_windows = _IS_WINDOWS, **kwargs)

def bun_test(name, **kwargs):
    """Runs `bun test` against `entry`."""
    _bun_test(name = name, is_windows = _IS_WINDOWS, **kwargs)

def bun_compile(name, **kwargs):
    """Compiles `entry` into a standalone executable that does not need Bun.

    `bazel run //products/carbon-cli:compile` — this is a release artifact
    builder, not a dev-loop step. The compiled binary is *slower* to start than
    `bun src/main.ts` (Bun's single-file-executable startup costs ~250 ms on
    Windows); its only advantage is running where Bun is not installed.

    Tagged `manual`, which is load-bearing rather than tidiness: `bun build`
    needs a real node_modules and writes into the source tree, and Bazel
    provides neither. Without the tag a plain `bazel build //...` picks this
    target up and fails on a clean checkout — which is what CI did, despite a
    comment in the BUILD file claiming the target was already excluded.
    """
    tags = kwargs.pop("tags", [])
    if "manual" not in tags:
        tags = tags + ["manual"]
    _bun_compile(name = name, is_windows = _IS_WINDOWS, tags = tags, **kwargs)
