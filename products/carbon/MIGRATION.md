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
`.tools/orchestration/bazel/cargo/Cargo.toml`, baselines captured. The original scope also listed
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
  versions it pulls. `.tools/orchestration/bazel/cargo/Cargo.lock` is seeded from V1 so the
  dependency set is the one V1 shipped — which is what "no functionality loss"
  requires anyway.
- **The JS renderers were in the wrong place.** `solid/` and `react/` lived
  under `engine/paint/renderers/` in V1, inside the Rust crate that rasterizes
  pixels. They are neither Rust nor rasterization — they are driving adapters,
  the same category as the CLI. Moved to `interface/renderer/`, and excluded
  from the TypeScript build until phase 6 wires their dependencies.

**4 — Host and platform. DONE.**

- [x] **`contracts/runtime`** — the JS ↔ Rust boundary, declared and checked.
      139 imports (Rust installs, JS calls) and 34 dispatchers (JS installs,
      Rust calls). `.tools/validation/check_host_boundary.py` compares the
      registry against the source in both directions and is wired into
      `check_workspace.py`, so it runs as part of one command.
- [x] **`infrastructure/platform`** — the per-OS shims. A real crate now; V1
      `#[path]`-included the source into each backend so it could share
      `UserEvent` and `tlog`, neither of which it actually uses.
- [x] **`infrastructure/os`** — the 19 `host/native` modules, ~4,000 lines,
      now a standalone crate.
- [x] **`infrastructure/plugin-host`** — loader and host_exports.
- [x] **`contracts/app/rust`** — V1's `shared/logic/core`, which plugin_loader
      needs for the `[plugins]` schema. It is the third rendering of
      carbon.toml, beside the JSON Schema and the TypeScript types.

### What phase 4 turned up

- **The boundary runs in two directions, and V1 documents neither.** 139
  functions Rust installs for JS to call, and 34 that JS installs for Rust to
  call. The second set is called from inside evaluated JS string literals —
  `"globalThis.__cm_dispatch_click && ..."` — so the name is opaque to rustc
  *and* to tsc. A rename on the JS side silently stops delivering the event.
- **Fifteen names looked like dispatchers and are not.** Rust both registers and
  calls them (reading back something it owns, like `__cm_app_name`). The rule
  that separates the lists is in the registry.
- **`stdlib/api/host/imports.ts` declares 69 of the 139 imports.** Its own comment asks people to
  keep it in step by hand. It has not been.

### The coupling that blocks `infrastructure/os`

`host/native` is not a crate in V1 — it is source compiled into each backend
binary, and it reaches into the including crate for:

| Reference | Count | What it is |
|---|---:|---|
| `crate::native` | 16 | its own siblings — fine once it is a crate |
| `crate::tlog` | 6 | the startup phase tracer |
| `crate::platform` | 6 | now `carbon-platform` |
| `crate::UserEvent` | 3 | the event enum posted back to the event loop |
| `crate::os_theme` | 1 | a sibling |

All five resolved, each from evidence rather than preference:

| Reference | Finding | Resolution |
|---|---|---|
| `crate::UserEvent` | **byte-identical** in both backends, comments stripped | `contracts/runtime/rust` |
| `crate::tlog` | mini traces every phase with deltas and is gated OUT by `CARBON_NO_TIMING`; blitz prints one line and is gated IN by `CARBON_MINI_TIMING` | a **port** — `register_all` takes `PhaseLogger` |
| `crate::platform` | plain std functions, no runtime types | `carbon-platform` |
| `crate::os_theme` | no coupling at all | a sibling module of `carbon-os` |
| `crate::native` | its own siblings | `crate::` once it is a crate |

**V1's own comment about this is wrong.** `carbon/runtime/mod.rs` says:

> `UserEvent`, `tlog`, and `json_escape` are NOT here — mini's and blitz's
> implementations of those differ (different UserEvent variants, different tlog
> verbosity), so each binary keeps its own.

That holds for `tlog`. It does not hold for `UserEvent`: diffing the two
definitions with comments stripped shows them identical, all eighteen variants
and every payload type. The stated reason for that duplication had stopped
being true, and nothing was checking.

### The checker had to learn about migration state

Standing up `carbon-os` made the boundary check fail with 61 issues — 29
imports and 32 dispatchers "missing". All of them live in `mini.rs`/`blitz.rs`,
which is phase 5.

A function that has not moved yet is not a function that was lost, and a check
that cannot tell them apart produces a wall of noise for work that has not
started — which is how a check gets ignored. The registry now records which V2
component owns each group, and a `[migration] migrated` list says which
components have actually moved. Only those are held to their declaration.

**110 of the 139 imports are verified present in migrated code.** The other 29
are reported as pending, by name, and will be checked the moment phase 5 adds
`composition` to that list.

**5 — The composition roots. DONE.**

Both binaries build in V2 and **the runtime launches a real app**: exit 0,
first paint, content ready, and the 27 startup phases in exactly the pinned
order. `products/carbon/tests/launch.rs` automates that — six assertions
against the real binary and a checked-in bundle.

**All 139 imports and 34 dispatchers are now verified present.** The boundary
check holds every component to its declaration; nothing is pending.

Both are also split. Moving first and splitting second was deliberate — a
working baseline in V2 is worth more than a tidy structure that does not run,
and `launch.rs` verified every stage of the split as it happened.

| | before | after | modules |
|---|---:|---:|---|
| `mini/main.rs` | 4,385 | **2,204** | timing · manifest · features · bundle · heap_snapshot · js · host_imports · scene_util |
| `blitz/main.rs` | 1,325 | **785** | timing · css · dom · host_imports · js |

Every module is a verbatim extraction — text moved, nothing rewritten — with
`use super::*` giving each one the crate root's imports. What remains in each
`main.rs` is `main()` and the event loop, which is one unit and should stay
one.

### What phase 5 turned up

- **V1 vendors a patched rquickjs-core.** `shared/vendor/rquickjs-core`, applied
  through `[patch.crates-io]` in the workspace root — a registry patch, not a
  path dependency, so every crate in the graph is redirected at once rather
  than ending up with two incompatible copies of the same types. The fork adds
  exactly one method, `Runtime::from_raw_restored`, which adopts a JSRuntime
  whose heap was mapped back from a snapshot. Without it the `snapshot` feature
  does not compile. Migrated to `integrations/javascript/quickjs`.
- **Three `net.rs` functions were `pub(crate)`.** `http_client`, `post` and `rt`
  are used by `async_image.rs`, which was in the same crate in V1 and is in
  `products/carbon` now. A crate boundary runs between them.
- **`tlog` being a port was the right call, and the compiler proved it.** Both
  binaries failed with "takes 3 arguments but 2 were supplied" until each passed
  its own. That is the difference phase 4 identified, enforced.

### What the split turned up

- **The extractor swept `use` lines into modules.** Attribute walk-back treats
  the comment block above an item as part of it, and a `use carbon_snapshot as
  snapshot;` sitting there went with it — shadowing the crate alias and
  producing forty "cannot find module" errors. Both cases were caught by the
  compiler, and the extractor now returns any stray top-level `use` to the
  crate root.
- **A module named `snapshot` collided with the crate aliased to `snapshot`.**
  Renamed to `heap_snapshot`; the crate keeps the name every call site uses.
- **`DocState`'s fields went private at a module boundary.** They were reachable
  when blitz was one file. `pub(crate)` restores exactly the old reach and no
  more.
- **The launch test was flaky, and the flake was real.** Six tests each spawned
  the runtime, cargo ran them in parallel, and under six concurrent windows a
  debug build missed its exit budget — three failures on one run, six passes on
  the next, no code change. Launching once and sharing the output removes the
  contention rather than papering over it with a longer timeout. Confirmed
  stable across three consecutive runs, and four times faster.

**6 — TypeScript tier. DONE.** `stdlib/`, the renderers, and the three.js and
xterm integrations.

| From V1 | To | Tier |
|---|---|---|
| `stdlib/api` | `interface/stdlib/api` | app-facing surface over `__cm_*` |
| `stdlib/compat/dom` | `interface/stdlib/dom` | browser API shims |
| `engine/paint/renderers/{solid,react}` | `interface/renderer/*` | wired and typechecking (phase 3 left them unbuilt) |
| `stdlib/compat/xterm` | `integrations/terminal/xterm` | role-then-vendor |
| `stdlib/three`, `stdlib/three-fiber` | `integrations/scene3d/*` | |
| `stdlib/term` | **`labs/term`** | see below |

`src/` folders were flattened to the root, matching every other solution.
Relative imports between siblings are unaffected by that move.

### What phase 6 turned up

- **`@carbon/term` targets a runtime that no longer exists.** Every host
  function it declares is `__ct_*`, its header points at
  `archive/runtimes/term/src/main.rs`, and zero of those names appear in
  `contracts/runtime`. The shipping runtime speaks `__cm_*`. It is parked in
  `labs/` with the reasoning recorded rather than filed under `interface/`,
  which would have claimed it works.
- **A real bug in it, deliberately not fixed.** `renderer.createElement(tag,
  props)` passes two arguments to a function that takes one — in solid-js's
  universal renderer interface *and* in carbon's own. The props are silently
  dropped, and the comment directly above says "we forward all props". Fixing
  it means inventing behaviour for an archived host layer; the typecheck error
  is the record.
- **TypeScript is no longer one project.** Five packages need `lib DOM` or
  `--jsx`, and those options must not reach the rest of the tree — with `lib
  DOM` in scope a stray `document.getElementById` compiles and fails at
  runtime. Each carries its own tsconfig now.
- **Which meant a checker.** `.tools/validation/check_typescript.py` discovers
  every tsconfig and runs all of them, because `tsc -p solutions` reporting
  zero errors looks identical whether it covers the tree or half of it — the
  exact way a stale `include` hid twice before. **It found a third instance on
  its first run**: `api/tsconfig.json` still said `include: ["src/**/*.ts"]`
  after the flattening.
- **`interface/stdlib/dom` cannot have `lib DOM`.** It *implements* those
  globals, so the library declarations would collide with its own. It declares
  the single type it needs (`BufferSource`) locally.

**7 — Closing the gaps. DONE.** Phases 1–6 moved the code. An audit of V1
against V2 afterwards found that the code had migrated almost exactly — all 139
host imports, every capability, every CLI command, the pipeline line for line —
and that what had *not* come across was everything around it: the enforcement,
the release path, the fixtures and the governance files.

Twenty-six findings, closed here. The ones that were breaking something:

| | Was | Now |
|---|---|---|
| `[profile.dist]` | `panic = "abort"`, which makes `catch_unwind` a no-op | `unwind` — the event loop's crash resilience works again |
| `labs/clipboard-plugin` | not a workspace member, and two stale V1 path depths | builds; the canonical Layer-2 example is reachable |
| `launch.rs` fixture | matched `dist/` in `.gitignore`, so untracked | committed via a negation rule — the test has an input on a clean clone |
| `ignore` crate | drifted to 0.4.30, which needs rustc 1.88 | pinned to V1's 0.4.23; `products/carbon` compiles on the declared MSRV again |
| `carbon-paint` | `#[cfg(feature = "profiling")]` on an undeclared feature | feature declared and forwarded from `products/carbon` — the paint zones were unreachable |
| notes-app, discord-app | imported `theme.tsx` / `Sidebar.tsx` / `store.ts`, none copied | restored; all four buildable examples import-complete |
| `publish.ts` delta path | `.tools/vendor/{bsdiff,zig-zstd}.exe` did not exist | replaced by `carbon-delta` in `capabilities/publishing/rust`; the vendored binaries are gone and delta publishing works off Windows |
| `bun_compile` | documented as excluded from `//...`, but untagged | `tags = ["manual"]`, applied by the macro |
| `bench-phase3.ps1` | built a `bench_runner` whose source never migrated | source restored as an explicit `[[bin]]`; script's V1 paths fixed |

And the enforcement that had no V2 equivalent at all — all of it as **Bazel
targets**, because Bazel is this workspace's entrypoint and a gate that only a
separate task runner could invoke is a gate that does not run:

| Target | Was |
|---|---|
| `//:fmt_test`, `//:clippy_test` | nothing checked formatting or lints |
| `//.tools/validation:workspace_test` | script, invoked by nothing |
| `//.tools/validation:host_boundary_test` | the label two BUILD files already cited, pointing at a package that did not exist |
| `//.tools/validation:typescript_test` | script, invoked by nothing |
| `//.tools/automation/ci:boundaries_test` | migrated file, invoked by nothing, V1-shaped |
| `//.tools/validation:baseline_check` | `bazel run` — needs ../V1, so not a test |

Plus the test preload (a `[test]` block in bunfig for `bun test`, and a
`preload` attribute on `bun_test` resolved through the runfiles MANIFEST,
because under `bazel test` bun runs outside the source tree and finds neither a
bunfig nor a relative path), the examples CI job, and `release.yml`.

Both workflows call `bazel` and nothing else.

### Two claims in this document were wrong

Recorded because both were load-bearing and neither was checked:

- **"a checked-in bundle"** (phase 5, on `launch.rs`). It was not checked in —
  `dist/` in `.gitignore` swept it up, so the only end-to-end test of the
  runtime had no input on a fresh clone. True now.
- **"`.tools/orchestration/bazel/cargo/Cargo.lock` is seeded from V1 so the dependency set is the
  one V1 shipped"** (phase 3). Sixteen crates had drifted from V1's lock. Most
  were harmless patch bumps; `ignore` was not, and it is what made the runtime
  fail to build on the 1.86 the workspace declares. The remaining fifteen are
  left alone deliberately — reverting patch versions with no failure attached
  is churn, not correctness.

### What phase 7 turned up

- **Neither `fmt-check` nor `lint` had ever passed, in either version.** V1's CI
  declared both gates and V1's own tree had 570 rustfmt diffs and the same
  clippy failures. So the gates were red from the day they were written. The
  tree is formatted now and clippy passes with `-D warnings`, which makes this
  the first time either gate means anything.
- **Two deny-by-default clippy errors in the plugin SDK.** `push.rs` takes
  `*mut CarbonApp` in safe functions. Marking them `unsafe fn` would push an
  `unsafe {}` block into every plugin's call site to restate a guarantee the
  runtime already makes through the C ABI, so it is allowed at the workspace
  level with the contract written down.
- **The lint debt is listed, not hidden.** `[workspace.lints.clippy]` names each
  allowed lint with a count and a reason instead of a blanket `-A clippy::all`,
  so it is countable and can be deleted line by line. Ten of them are
  `missing_safety_doc` on FFI and snapshot code, left for whoever knows the
  contract — a safety comment that is wrong is worse than one that is absent.
- **Twelve `workspace:*` dependencies survived**, in the example apps, the
  ts-plugin and `three-fiber` — despite the V2 README stating there are none
  anywhere. V2 has no bun workspace, so each would fail `bun install` outright.
  They were inert only because `BunBundler` resolves `@carbon/*` from absolute
  paths exported by `@carbon/workspace` rather than from node_modules.
- **The toolchain was never pinned, and two crates were relying on that.**
  `rust-version = "1.86"` is an MSRV assertion, not a toolchain selector, so
  every build silently used whatever `rustup default` happened to be — 1.96 on
  the machine this was written on. Pinning it (RUSTUP_TOOLCHAIN in the Bazel
  cargo launcher, rather than a rust-toolchain.toml at the root) surfaced two
  things at once: the `ignore` lockfile drift above, and that
  `carbon-gpu-canvas` still does not build on 1.86. Phase 3 recorded that crate
  as fixed; it was only ever compiling because the pin was missing. It is now
  tagged `manual` with the two ways out written down, rather than passing by
  accident.
- **`terax-ai` is not ours to migrate.** It is a checkout of
  `github.com/crynta/terax-ai` with its own `.git`, and carbon's repository
  never tracked a file of it. V2 carrying only its `carbon.toml` is correct, and
  the examples CI job skips any app directory with no `package.json` for that
  reason.

## The build decision, made

**Bazel drives Cargo.** `crate_universe` would need all 123 build-script
dependencies working under Bazel on three platforms — `rquickjs-sys` (compiles
QuickJS C, runs bindgen), `ring` (assembly), `ash`/`naga` behind wgpu. The
runtime needs the MSVC linker on Windows regardless, so hermeticity is out of
reach either way. Bazel owns the graph; Cargo compiles. Same arrangement as the
Bun rules, for the same reason.

**No new Cargo files in the root.** The workspace manifest is
`.tools/orchestration/bazel/cargo/Cargo.toml`, and the settings that would otherwise need a root
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
  with a workspace manifest in `.tools/orchestration/bazel/cargo`. `rules_rust` is already a
  `bazel_dep`. Whether Bazel drives Cargo or replaces it is a decision phase 1
  has to make and is not yet made.
- **`gpu-canvas` needs a GPU.** Its tests cannot run in CI or in the container
  without a software adapter.
