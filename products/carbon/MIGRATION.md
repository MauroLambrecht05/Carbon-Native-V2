# Migrating Carbon itself into V2

The runtime, the host layer, the engines and the SDK — everything that is not
the CLI. ~35,000 lines of Rust across 14 crates, restructured onto the same
clean-core layering the TypeScript side already uses.

Written before anything moves, because the failure mode here is not a broken
build. It is a subsystem that quietly stops being reachable.

## What is being moved

Measured, not estimated:

| Source | Lines | Becomes |
|---|---:|---|
| `carbon/runtime/mini.rs` | 4,441 | `products/carbon/` composition + several capabilities |
| `carbon/runtime/blitz.rs` | 1,344 | `products/carbon/` + `integrations/renderer/blitz` |
| `carbon/runtime/engine/paint` | 3,915 | `capabilities/painting` |
| `carbon/runtime/engine/layout` | 3,726 | `capabilities/layout` |
| `carbon/runtime/engine/gpu-canvas` | 3,406 | `capabilities/gpu-canvas` |
| `carbon/runtime/features/math` | 3,791 | `capabilities/math` |
| `carbon/host/audio` | 3,538 | `capabilities/audio` |
| `carbon/host/native` (19 modules) | 3,997 | `infrastructure/os/*` |
| `carbon/runtime/features/image` | 1,603 | `capabilities/imaging` |
| `ecosystem/users/sdk/rust` + `zig` | 1,157 | `capabilities/plugin-sdk` |
| `carbon/api` | 950 | `infrastructure/plugin-host` |
| `carbon/runtime/features/snapshot` | 881 | `capabilities/snapshot` |
| `carbon/runtime/engine/text-renderer` | 831 | `capabilities/text` |
| `shared/logic/core` | 643 | `contracts/app` (Rust side) + `infrastructure/` |
| `ecosystem/system/clipboard` | 524 | `labs/` or an example plugin |
| `carbon/platform` | 83 | `infrastructure/platform` |

Plus the TypeScript that ships with the runtime: `ecosystem/system/stdlib/`
(api, compat/dom, compat/xterm, term, three, three-fiber) and the two renderers
under `engine/paint/renderers/{solid,react}`.

## The one contract that does not exist yet

`carbon/host/native/mod.rs` registers 139 globals onto a QuickJS context. The
JS side calls them by string name. Nothing declares that surface — it is
implied by matching string literals on both sides of an FFI boundary, in two
different languages.

That is the single highest-value thing this migration produces:
`contracts/runtime/`, holding the host-function registry as a language-agnostic
definition, with generated Rust and TypeScript sides. Until it exists, "no
functionality loss" is checked by a script grepping for string literals — which
is what `.tools/validation/baselines/` does today, and which is a stopgap.

## Target structure

```
products/carbon/                    the two shipped binaries
├── mini/                           composition root for carbon-mini
├── blitz/                          composition root for carbon-blitz
└── tests/                          launches example apps, asserts the phases

solutions/
├── contracts/
│   ├── runtime/          NEW  the 139 host functions, node kinds, prop names
│   ├── plugin/           has   abi/carbon_abi.h  (+ Rust and Zig sides)
│   ├── host/             has   api.fbs, events.fbs, ipc.fbs
│   └── app/              has   carbon.toml — gains its Rust side
│
├── capabilities/
│   ├── layout/                 scene graph, Taffy, CSS value parsing
│   ├── painting/               tiny-skia dispatch, canvas2d, svg, blur
│   ├── text/                   fontdue engine
│   ├── gpu-canvas/             wgpu surface, geometry, materials
│   ├── imaging/                decode, cache, async load
│   ├── audio/                  Web Audio graph
│   ├── math/                   Vector3, Matrix4, Quaternion, Box3, Frustum
│   ├── snapshot/               heap snapshot / restore
│   └── plugin-sdk/             what plugin authors compile against
│
├── infrastructure/
│   ├── os/                     the 19 host/native modules, behind ports
│   ├── platform/               windows · macos · unix
│   └── plugin-host/            loader, host_exports
│
├── integrations/
│   ├── javascript/quickjs/     the rquickjs binding layer
│   ├── windowing/tao/          event loop, window
│   └── renderer/blitz/         stylo + vello + wgpu
│
└── interface/
    └── renderer/{solid,react}  the JS-side renderers
```

Rationale for the placements that are not obvious:

- **`tao` and `rquickjs` are integrations, not infrastructure.** They are named
  outside technologies, and the tier is named by role — `windowing/`,
  `javascript/` — so swapping winit for tao changes a leaf.
- **`blitz` is an integration, not a capability.** It is someone else's renderer
  (stylo + vello). `painting/` is ours.
- **`host/native` is infrastructure, not a capability.** Reading a file is a
  driven adapter. The capability is whatever calls it.
- **`plugin-sdk` is a capability, not a product.** It is not a binary we ship;
  it is a library plugin authors depend on. `capabilities/plugins` (already in
  V2) points at it, which closes the `packages/carbon-sdk` gap noted there.

## Phases

Each phase ends green — build, tests, baseline check — so the work can stop
between any two without leaving the tree half-moved.

**1 — Build plumbing. DONE.** Bazel-drives-Cargo decided and built
(`.tools/orchestration/bazel/cargo`), workspace manifest at
`.config/rust/Cargo.toml`, baselines captured. The original scope also listed
`contracts/runtime`; that moved to phase 4, where the host layer it describes
actually lands — declaring 139 functions before their implementations move
would be writing the contract against V1's shape rather than the one they end
up in.

**2 — Leaf capabilities. DONE.** `math`, `text`, `snapshot`, `imaging`,
`audio` — the five crates with no dependency on the runtime and their own
existing tests. Lowest risk, and they prove the Cargo-under-Bazel setup on real
code.

All five migrated, **52 Rust tests passing** through `bazel test`. Every crate
keeps its module names via `#[path]`, so no public API changed; the crate root
is `lib.rs` beside its folders rather than `src/lib.rs`.

| Capability | Tests | Layout |
|---|---:|---|
| `math` | 13 | `domain/` — the six types |
| `text` | 0 | flat — one struct, one impl, no seam |
| `snapshot` | 0 | flat — all infrastructure, no model |
| `imaging` | 30 | `domain/` `application/` `infrastructure/` |
| `audio` | 9 | `graph/` `nodes/` `infrastructure/` |

`text` and `snapshot` kept flat layouts deliberately. `text` is one cohesive
`TextEngine` struct with a single impl and no tests; splitting it would mean
either scattering one impl across modules for the directory listing's sake, or
inventing an interface between halves that have never been apart. `snapshot` is
*entirely* infrastructure — a custom QuickJS allocator over a fixed-address
VirtualAlloc region — so a `domain/` there would have been empty. The shape
should describe the code.

`audio` has no `domain/` and that is a finding, not an omission: the first
attempt put `buffer` and `routing` there, and both import `crate::mixer` for
`with_graph_mut`. A Web Audio node is a handle into one global mutable graph
that an audio thread reads concurrently — no layer of that crate is free of it,
so `domain/` would have been a label rather than a boundary. It became
`graph/`.

**3 — The engines. DONE.** `layout`, `painting`, `gpu-canvas`.

| Capability | Tests | Layout |
|---|---:|---|
| `layout` | 27 (new) | all `domain/` — scene + css_parse, mutually recursive |
| `painting` | 9 (new) | `domain/blur` · `infrastructure/{canvas2d,svg}` |
| `gpu-canvas` | 30 (recovered) | `domain/{geometry,material,uniforms}` · `infrastructure/{gpu,executor}` |

`gpu-canvas` keeps `gpu` and `executor` in one layer because they import each
other — which is why V1 extracted this as one crate rather than five, Cargo
forbidding circular crate deps. A cycle cannot straddle a layer boundary
either. `domain/shaders/` sits beside `material.rs` because `include_str!`
resolves relative to the file.

`layout` is entirely domain: it computes, and Taffy is a library it computes
with, not an outside system it talks to.

### What phase 3 turned up

- **`carbon-gpu-canvas` does not build in V1.** It is excluded from
  `build-all`, `test` and `clippy` there (see V1's `.config/justfile`) because
  wgpu 27 wants rustc 1.88 and the pin is 1.86. That exclusion was hiding a
  second, unrelated bug: its manifest never declared `serde_json`, which
  `executor.rs` uses throughout. Both are fixed — it compiles here.
- **30 tests that have never executed.** They live inside `gpu-canvas` in V1
  and were skipped along with the crate. They now run, and pass.
- **A fresh dependency resolution breaks wgpu.** Resolving from scratch picked
  `wgpu-hal 27.0.4`, which fails to compile against the `windows` crate
  versions it pulls. `.config/rust/Cargo.lock` is seeded from V1 so the
  dependency set is the one V1 shipped — which is what "no functionality loss"
  requires anyway.
- **The JS renderers were in the wrong place.** `solid/` and `react/` lived
  under `engine/paint/renderers/` in V1, inside the Rust crate that rasterizes
  pixels. They are neither Rust nor rasterization — they are driving adapters,
  the same category as the CLI. Moved to `interface/renderer/`, and excluded
  from the TypeScript build until phase 6 wires their dependencies.

**4 — Host and platform.** The 19 `host/native` modules into `infrastructure/os`
behind ports, `platform/`, `plugin-host/`. This is where the 139-function
contract gets enforced for the first time.

**5 — The composition roots.** Split `mini.rs` (4,441 lines) and `blitz.rs` into
`products/carbon/`. Highest risk in the whole migration: this file holds the
startup ordering, and the ordering is the thing `startup-phases.txt` exists to
protect.

**6 — TypeScript tier.** `stdlib/`, the solid and react renderers, the type
definitions.

## The build decision, made

**Bazel drives Cargo.** `crate_universe` would need all 123 build-script
dependencies working under Bazel on three platforms — `rquickjs-sys` (compiles
QuickJS C, runs bindgen), `ring` (assembly), `ash`/`naga` behind wgpu. The
runtime needs the MSVC linker on Windows regardless, so hermeticity is out of
reach either way. Bazel owns the graph; Cargo compiles. Same arrangement as the
Bun rules, for the same reason.

**No new Cargo files in the root.** The workspace manifest is
`.config/rust/Cargo.toml`, and the settings that would otherwise need a root
`.cargo/config.toml` are exported by the launcher instead — verified that cargo
reads them, by feeding `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS` a bad value
and watching cargo reject it. Build output goes to `.build/`, already
gitignored.

Three problems that only appear under `bazel test`, all written up in
`.tools/orchestration/bazel/cargo/`:

- `features` is a **built-in Bazel attribute** and cannot be overridden. The
  rule calls it `crate_features`, as `rules_rust` does.
- `bazel test` **scrubs the environment**, so a run-time search for
  `~/.cargo/bin` sees nothing and reports a missing toolchain that is installed.
  Resolved at fetch time by a repository rule instead.
- `bazel test` leaves the working directory in the execroot, so a relative
  `--manifest-path` resolves against nothing. The workspace root is captured at
  fetch time for the same reason.

## Drift found while doing this

Recorded because each was a real inconsistency, not a preference:

- `.config/dependencies.json` declared Rust **1.76.0**; V1's workspace requires
  **1.86**, and that is what is installed. The Dockerfile installed 1.76.0 too,
  so the container could not have built the runtime. All three now say 1.86.0.
- `MODULE.bazel` registered a `rules_rust` toolchain pinned to 1.76.0. Aligned,
  and marked as the unused escape hatch it is.

## How each phase is verified

1. `cargo build` for the touched crates — a real compile, with the toolchain at
   `C:\Users\mauro\.cargo\bin` (cargo 1.86.0, not on PATH by default).
2. `cargo test` for crates that have tests (`math`, `image`, `audio`, the SDK's
   `abi_compat_test`).
3. `capture_baseline.py --check` — the 139 functions, 9 features, 23 env vars.
4. From phase 5, the launch test: build an example app, run the binary against
   it with `CARBON_TEST_EXIT_MS`, assert exit 0 and the 27 phases in order.
5. `bazel build //...` and the workspace validator, as with everything else.

## The launch test

V1 has a test hook that makes this possible:

```
CARBON_TEST_EXIT_MS=2500 carbon-mini.exe shared/examples/my-app
```

auto-exits cleanly after N ms, so stderr flushes and the exit code is real.
Verified working against the prebuilt V1 binary — 347 ms to first paint, exit 0,
27 phases.

Five example apps exist in V1: `my-app`, `notes-app`, `discord-app`, `react`,
`terax-ai`. The first three are the useful ones — `react` proves the second
renderer, `terax-ai` is a large real application and the best end-to-end signal.

`CM_DUMP=1` prints the layout tree, and `CM_SCREENSHOT=<path>` writes a PNG on
the blitz backend. Both are assertion surfaces beyond "did it exit 0".

## Known risks

- **No baseline test suite.** The runtime has essentially no tests — one
  `plugin_loader_test.rs`. Everything else is verified against the captured
  surface plus the launch test. Tests get written as each capability lands,
  which is slower but is the only way this is checkable at all.
- **`mini.rs` is a 4,441-line composition root** holding startup ordering,
  event-loop dispatch, the renderer bridge and 56 host-function registrations.
  Splitting it is phase 5 for a reason.
- **Two backends share one Cargo package** via `include!` of `mod.rs` and
  mutually exclusive features. Cargo has no per-binary dependency scoping, which
  is *why* it is shaped that way — see the comment at the top of
  `carbon/runtime/Cargo.toml`. Any restructure has to preserve that property or
  every build compiles both stacks.
- **Cargo and Bazel both want to own the build.** V2 is Bazel-only; V1 is Cargo
  with a workspace manifest in `.config/rust`. `rules_rust` is already a
  `bazel_dep`. Whether Bazel drives Cargo or replaces it is a decision phase 1
  has to make and is not yet made.
- **`gpu-canvas` needs a GPU.** Its tests cannot run in CI or in the container
  without a software adapter.
