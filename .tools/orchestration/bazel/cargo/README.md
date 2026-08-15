# cargo orchestration

Bazel targets that build Rust through Cargo.

```python
load("//.tools/orchestration/bazel/cargo:defs.bzl", "cargo_binary", "cargo_test")

cargo_binary(
    name = "mini",
    package = "carbon-runtime",
    bin = "carbon-mini",
    crate_features = ["mini", "snapshot"],
    profile = "dist",
    srcs = glob(["**/*.rs"]),
)

cargo_test(
    name = "math_test",
    package = "carbon-fast-math",
    srcs = glob(["**/*.rs"]),
)
```

## Why not rules_rust

`rules_rust` is already a `bazel_dep`, and for a pure-Rust tree it would be the
better answer. This tree is not pure Rust: **123 of the runtime's transitive
dependencies run build scripts**, including `rquickjs-sys` (compiles QuickJS C
sources, runs bindgen), `ring` (per-target assembly), and `ash`/`naga` behind
wgpu.

Porting all 123 to `crate_universe` across three host platforms is a project
whose payoff is caching a graph Cargo already caches well — and the runtime
still needs the MSVC linker on Windows, so hermeticity is out of reach either
way.

Every target here names a package and a feature list, which is what a
`rust_library` needs too. Switching later is a rule swap, not a re-architecture.

## Where the manifest lives

`.tools/orchestration/bazel/cargo/Cargo.toml`, not the repository root.

Cargo only walks *up* looking for a workspace, so each crate carries an explicit
`workspace = "<relative path>"` key pointing back at it. That is the same
arrangement V1 used, and it is what keeps the root free of build-system files —
`MODULE.bazel` and `BUILD.bazel` are the only ones there.

The exception is `.cargo/config.toml`, which Cargo discovers by walking up from
the *current directory* rather than from the manifest. Moving it would silently
drop `target-dir` and rustflags for anyone running cargo by hand.

## Finding cargo

In order: `$CARGO_HOME/bin`, `~/.cargo/bin`, then `$PATH`.

rustup's directories come first deliberately — rustup does not always put itself
on `PATH`, and this workspace's own machine is an example: cargo 1.86.0 is
installed while a bare `cargo --version` in a fresh shell reports
"command not found". Searching `PATH` first would have made the rules report a
missing toolchain that was in fact present.

The pinned version is in `.config/dependencies.json`, per
`contracts/toolchain`.

## What this does not do

It does not sandbox the build. The launcher chdirs to
`BUILD_WORKSPACE_DIRECTORY` and lets Cargo's own `target/` do the incremental
work, so Bazel cannot cache below the level of "this target ran". Same
compromise as the Bun rules, made for the same reason and written down for the
same reason.
