# Contributing to carbon-native

## The one question

Every directory answers one question, so you never have to guess where something
goes:

> ### "Does this SHIP, is it REUSED, or does it only run on my machine?"

| Answer | Home |
|---|---|
| A shipped binary — the runtime, the CLI | `products/<name>/` |
| An agreement two tiers depend on | `solutions/contracts/` |
| Something carbon *does* — layout, painting, audio, signing | `solutions/capabilities/` |
| A vendor-neutral technical service — OS access, logging, process | `solutions/infrastructure/` |
| A named outside technology — vite, babel, three.js, quickjs | `solutions/integrations/` |
| A surface something reaches carbon through — CLI kernel, renderers | `solutions/interface/` |
| Developer automation that never ships | `.tools/` |
| An experiment, or something parked with its reasoning | `labs/` |

A product **composes and presents** — it holds no domain or application layer.
If you are writing a business rule in `products/`, it belongs in a solution; if
you are writing a user interface in `solutions/`, it belongs in a product. See
[`products/README.md`](../products/README.md) and
[`solutions/README.md`](../solutions/README.md).

If two answers seem to fit, the code is doing two things and wants splitting.

## Getting set up

```sh
# Dependencies, in two steps. bun installs into .config/; the junction is what
# makes node_modules reachable from products/ and solutions/, because bun
# resolves by walking UP from the importing file and would never look inside
# .config/ on its own.
bun install --cwd .config
./.tools/automation/bootstrap/link-node-modules.sh   # .ps1 on Windows

bazel build //products/carbon:mini                   # the runtime
bazel run   //products/carbon-cli:carbon -- run labs/examples/notes-app
```

On Windows, activate MSVC first:
`. .\.tools\automation\bootstrap\activate-msvc.ps1`

**Bazel is the entrypoint.** There is no task runner and no wrapper script: if a
workflow is not a Bazel target, it is not a workflow yet. That is what keeps CI
and your machine running the same thing — every CI job invokes `bazel` and
nothing else.

Bazel owns the graph; Cargo and Bun stay the compiler drivers. The reasoning is
in [`.tools/orchestration/bazel/cargo/defs.bzl`](../.tools/orchestration/bazel/cargo/defs.bzl),
which also pins the Rust toolchain to 1.88.0 via `RUSTUP_TOOLCHAIN` and carries
the four settings a root `.cargo/config.toml` would otherwise hold.

The workspace root holds Bazel's files and the tier directories, nothing else.
`//.tools/validation:workspace_test` enforces that as an allow-list, so putting
something there is a deliberate edit with a reason — not something that happens.

## Before you push

```sh
bazel test //...    # unit tests, structure, host boundary, tsc, fmt, clippy
```

That is exactly what CI runs, so a green `bazel test //...` is a green pipeline.

Individually, for a faster loop:

| | |
|---|---|
| `bazel test //:fmt_test` | rustfmt — `bazel run //:fmt` fixes it in place |
| `bazel test //:clippy_test` | clippy with `-D warnings` |
| `bazel test //.tools/validation/...` | structure, host boundary, every tsconfig |
| `bazel test //.tools/automation/ci:boundaries_test` | the rules below |

`carbon-gpu-canvas` lives at `labs/gpu-canvas` — parked, not actively used, and
not a member of the shared Cargo workspace, so `bazel test //...` never sees
it at all. Build or test it standalone: `cd labs/gpu-canvas && cargo build`.

CI's `test` and `examples` jobs run on whatever OSes the `CI_WINDOWS_ONLY`
repo variable says to (computed once, in the `structure` job): `true` means
windows-latest only, matching this project's current ship target; anything
else runs the full windows/ubuntu/macos matrix. Flip it with
`gh variable set CI_WINDOWS_ONLY --body false` (or Settings -> Secrets and
variables -> Actions -> Variables) — no workflow edit needed. Branch
protection on `main` only requires the windows-latest checks, since the
other two are conditional on this toggle; widen it back to all three the
same day you flip the toggle to `false`, or a real ubuntu/macos regression
can merge silently.

## The rules CI enforces

Two checks, split by what they can see.

**`//.tools/validation:workspace_test`** — tier direction (contracts depend on
nothing; nothing depends on interface), dependency direction (`domain/` imports
nothing outward), the contract pattern, the product template, root hygiene, and
the toolchain versions agreeing between `.config/dependencies.json` and
`MODULE.bazel`. It also runs the host-boundary and TypeScript checks.

**`//.tools/automation/ci:boundaries_test`** — the structural rules the above
does not cover:

1. **Directory name == artifact name.** A package aliased as `@carbon/three` in
   `.config/tsconfig.base.json` must call itself that. The alias is what
   resolves, so a disagreement fails silently at publish rather than loudly at
   build.
2. **One lockfile per ecosystem.** One `Cargo.lock` and one `bun.lock`, both in
   `.tools/orchestration/bazel/cargo/` and `.config/` respectively. The
   self-contained benchmark harnesses are pinned apart
   deliberately so a dependency bump cannot silently move a measurement, and a
   carbon app carries its own lockfile because it is its own npm project.
3. **No committed binaries.** Build them in CI. There is no exception. The one
   that existed — `.tools/vendor/`, holding a checksummed `bsdiff.exe` and
   `zig-zstd.exe` — is gone: both are now `carbon-delta`, built from
   `solutions/capabilities/distribution/publishing/rust`, which also made `carbon publish`
   work off Windows for the first time.
4. **Embedded fonts carry their licenses.** Everything in
   `solutions/capabilities/rendering/text/assets/` is compiled into every shipped binary,
   so shipping it without the license text is a redistribution problem.

## The boundary that has no compiler

`contracts/runtime/registry/host-boundary.toml` declares 139 functions Rust
installs for JS to call, and 34 that JS installs for Rust to call. Both
directions are string literals across an FFI boundary in two languages — rustc
sees nothing, tsc sees nothing. `//.tools/validation:host_boundary_test`
compares the registry against the source both ways.

Adding or renaming a host function means editing that registry in the same
change. It is the only thing standing between a rename and an event that
silently stops being delivered.

## Changing the manifest

`carbon.toml`'s shape is defined once, in
[`solutions/contracts/app/schema/carbon.schema.json`](../solutions/contracts/app/schema/carbon.schema.json).
Two parsers implement it — `contracts/app/types/CarbonManifest.ts` and
`contracts/app/rust/config.rs` — and `contracts/app/tests/conformance.test.ts`
fails if any of the three drift.

**Change the schema first**, then both parsers. The suite checks that the
default backend agrees across all three, and that every `[runtime]` boolean
exists on both sides.

## Adding things

**A backend.** Add a `[[bin]]` to `products/carbon/Cargo.toml` with its
exclusive dependencies `optional = true` behind a same-named feature (Cargo has
no per-binary dependency scoping — see that file's header), an entry in
`solutions/contracts/app/types/Backend.ts`, and the name in the schema's
`runtime.backend` enum. Nothing else hardcodes a backend name.

**A host API.** Implement it in `solutions/infrastructure/os/`, register it in
`plugin-host/host_exports.rs`, declare it in
`contracts/runtime/registry/host-boundary.toml`, and add the TypeScript
declaration to `interface/stdlib/api/` — all in the same change, or the boundary
check fails.

**A native plugin.** Start from `solutions/capabilities/plugin/sdk/`.
`labs/clipboard-plugin/` is the reference implementation of the C ABI.

**A benchmark.** Extend
`.tools/automation/benchmarks/runtime/bench-runtime-v2.ps1`; never break
backward compatibility with v1. Each session writes a **new** dated folder under
`.tools/automation/benchmarks/results/` — never overwrite a previous one.

## Tests

- **TypeScript** — `bun:test`, in a `tests/` directory beside the code.
- **Rust** — `cargo test`, in `tests/` (cargo's convention) or inline
  `#[cfg(test)]`.
- Use `@carbon/testing` for temp directories, project fixtures and CLI
  invocation rather than hand-rolling them.
- `bazel test //...` runs both. `bun test <filter>` runs one TypeScript suite;
  `bazel test //solutions/capabilities/rendering/math:math_test` runs one Rust crate's.

A test that is `#[ignore]`d or skipped must say why in the annotation itself.

## Commits and PRs

Conventional-commit prefixes (`feat:`, `fix:`, `refactor:`, `perf:`, `docs:`,
`test:`, `chore:`), scoped where it helps: `fix(products/carbon): …`.

Performance claims need a number from `.tools/automation/benchmarks/` in the PR
body. This project's entire argument is measured, so "faster" without a
measurement isn't reviewable.
