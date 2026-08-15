# Carbon Native V2 — Architecture & Workspace Documentation

Welcome to **Carbon Native V2**, a high-performance, polyglot native execution platform built for maximum speed, safety, extensibility, and strict architectural modularity.

---

## 1. Executive Summary & Vision

Carbon Native V2 is engineered as an interface-first, zero-copy native architecture. Instead of restricting the ecosystem to a single programming language, V2 leverages a **polyglot language topology** where each language is assigned a dedicated role based on its hardware characteristics and language guarantees.

---

## 2. Polyglot Language Matrix & Responsibilities

```
                                ┌──────────────────────────────────────────────┐
                                │    Contract / Schema Definition Layer        │
                                │   FlatBuffers IDL (.fbs) — Zero-Copy IDL     │
                                └──────────────────────┬───────────────────────┘
                                                       │ Generates Bindings
  ┌────────────────────────────────────────────────────┼────────────────────────────────────────────────────┐
  │                                                    │                                                    │
  ▼                                                    ▼                                                    ▼
┌──────────────────────────┐         ┌──────────────────────────┐         ┌──────────────────────────┐
│    C++ Compute Engine    │         │  Zig Plugin & Extension  │         │    Rust Systems Core     │
│  SIMD, Vector Math, Raw  │         │   C-ABI Hooks & Dynamic  │         │  Thread & Memory Safety, │
│       Performance        │         │        Allocators        │         │   Async Net, Processes   │
└─────────────┬────────────┘         └─────────────┬────────────┘         └─────────────┬────────────┘
              │                                    │                                    │
              └────────────────────────────────────┴────────────────────────────────────┘
                       Shared Native C-ABI Boundary (contracts/abi/carbon_abi.h)
                                                       │
                                                       ▼
                                     ┌───────────────────────────────────┐
                                     │        Tooling & CLI Layer        │
                                     │      TypeScript / Go / Rust       │
                                     └───────────────────────────────────┘
```

| Language / Tool | Architectural Role | Responsibility |
| :--- | :--- | :--- |
| **C++ (C++20)** | **Critical Compute Engine** | Ultra-low latency calculation, vector math, SIMD intrinsics, raw memory operations. |
| **Zig (0.12+)** | **Extension & Plugin Points** | Plugin ABI boundaries (`@export`, `extern fn`), dynamic module hooks, custom allocator passing. |
| **Rust (2021)** | **Safety & Systems Core** | Process orchestration, thread safety, async network transport (Tokio), memory-safe state management. |
| **FlatBuffers IDL** | **Contract & Schema Layer** | Single source of truth for cross-language data structures (`.fbs`). Zero-copy deserialization over shared memory. |
| **TypeScript / Go** | **Tooling & CLI** | Ergonomic developer CLI tools (`carbon-cli`), build tools, cloud orchestration, web integrations. |
| **Bazel (7.0+)** | **Unified Build System** | Hermetic, reproducible builds across C++, Rust, Zig, Go, TS, and Dotnet using Bzlmod. |

---

## 3. Directory Layout & Architecture Rules

**The workspace root holds Bazel's files and the tiers.** Configuration lives
in `.config/` and developer tooling in `.tools/`. Generated output lives beside
whatever produces it — cargo's `target/` next to the Cargo workspace manifest,
the FlatBuffers bindings next to the generator — and every such directory is
gitignored.

The blocks below are **checked**, not decorative.
`//.tools/validation:workspace_test` parses them and fails when the tree and
this document disagree — in either direction. Every path declared here must
exist, and every entry at the root, in `.config/` and in `.tools/` must be
declared here. That check exists because this section spent the migration
describing a tree that had stopped being true, and four directories
accumulated in it that nobody had decided to add.

```text
V2/
├── MODULE.bazel                       # Bzlmod: external deps and toolchain registration
├── BUILD.bazel                        # Root visibility packages
├── .bazelrc                           # Compiler flags, platform profiles, caching
├── .bazelversion                      # Pinned Bazel release (bazelisk reads this)
├── README.md                          # This file
├── .cargo/                            # Cargo's own config — it walks UP from cwd to find it
├── .config/                           # Configuration, and nothing that is not
├── .github/                           # Workflows, CONTRIBUTING, SECURITY, issue templates
├── .tools/                            # Developer automation that never ships
├── labs/                              # Experiments. Disposable contents, permanent directory
├── products/                          # Shipping deliverables
├── solutions/                         # Everything the products are built out of
├── .env                               # Machine-local, gitignored
├── .env.example                       # …and the template that documents it
├── .gitattributes
├── .gitignore
├── .git/                              # generated
└── node_modules/                      # generated — a junction into .config/node_modules
```

### `.config/` — configuration, and nothing that is not

```text
.config/
├── _identity.json                     # System identity and language ABI metadata
├── build.json                         # Build profiles (debug, release, dist)
├── dependencies.json                  # Toolchain and library version matrix
├── features.json                      # Feature flags (SIMD, zero-copy, Zig plugins)
├── package.json                       # Third-party npm deps for the TypeScript tier
├── bun.lock                           # …and its lockfile
├── bunfig.toml                        # Bun's own settings
├── tsconfig.base.json                 # @carbon/* path aliases (this replaces bun workspaces)
├── BUILD.bazel                        # Exposes the tsconfig to Bazel targets
├── platforms/                         # windows.toml · linux.toml · macos.toml
├── toolchains/                        # Toolchain specs: cpp · rust · zig
└── node_modules/                      # generated by `bun install --cwd .config`
```

There is **no `rust/` here.** The Cargo workspace manifest used to sit at
`.config/rust/Cargo.toml`, next to `.config/toolchains/rust/` — two directories
called `rust` in one place, one a toolchain spec and one a 17-member workspace.
A workspace manifest is a build definition, so it moved to
`.tools/orchestration/bazel/cargo/`, beside the rules that invoke it.

### `.tools/` — developer automation that never ships

```text
.tools/
├── automation/                        # bootstrap · build · release · testing · ci · benchmarks
├── environments/                      # docker · devcontainer
├── generators/                        # FlatBuffers binding generator (Python)
├── integrations/                      # Editor and external-tool glue
├── orchestration/                     # Bazel rules: bazel/bun · bazel/cargo (Cargo.toml + target/)
└── validation/                        # The workspace validators (Python)
```

Three things are **not** here, and each was:

- **`.build/`** held 11 GB of Cargo output under a name the root README never
  declared, that only one line in `defs.bzl` pointed at, and that a hand-typed
  `cargo build` never wrote to. Cargo's output is now `target/` beside the
  workspace manifest in `orchestration/bazel/cargo/`, which is Cargo's own
  default.
- **`vendor/`** held two committed Windows `.exe` files, `bsdiff.exe` and
  `zig-zstd.exe`, which made `carbon publish` a Windows-only command. They are
  `carbon-delta` now, built from `solutions/capabilities/publishing/rust`, and
  the no-committed-binaries rule has no exception left.
- **`tsconfig.json`** claimed the whole tier as one TypeScript project. Only
  `automation/` is TypeScript — `orchestration/` is Starlark, `generators/` and
  `validation/` are Python — and its own `include` already said so. It now sits
  at `.tools/automation/tsconfig.json`.

### The tiers

```text
products/
├── carbon/                            # The runtime: carbon-mini and carbon-blitz
├── carbon-cli/                        # The app developer's surface
├── carbon-ext/                        # The plugin SDK: header, templates, package definition
└── README.md                          # The product template every one of them follows
```

```text
solutions/
├── contracts/                         # Agreements that must not drift apart
├── capabilities/                      # What carbon can do
├── infrastructure/                    # Vendor-neutral technical services — ports/ + adapters/
├── integrations/                      # Outside technologies, named by ROLE then vendor
├── interface/                         # How application code and developers reach the runtime
├── tsconfig.json                      # extends .config/tsconfig.base.json for this tree
└── README.md                          # The shape each tier's packages follow
```

Products depend on solutions; solutions never depend back. Within `solutions/`
the direction is a DAG rather than a line, and
`//.tools/validation:workspace_test` enforces the two edges with teeth:
contracts import nothing, and nothing imports `interface/`.

### Why there is no `package.json` at the root

Bun and Node resolve packages by walking **up** from each importing file, so a
`node_modules` that exists only inside `.config/` is invisible to `products/`
and `solutions/`. The manifest still lives in `.config/`; a `node_modules`
junction at the root makes it reachable:

```bash
bun install --cwd .config
./.tools/automation/bootstrap/link-node-modules.sh      # or .ps1 on Windows
```

Only `.config/package.json` and `.config/bun.lock` are source. The root
`node_modules` is a generated link and is gitignored.

Internal `@carbon/*` wiring is **not** a package-manager concern: it is path
aliases in `.config/tsconfig.base.json`. There is no `workspaces` array and no
`workspace:*` dependency anywhere. Each tree that imports `@carbon/*` needs a
`tsconfig.json` extending that base, because Bun resolves aliases from the
tsconfig nearest the *importing* file.

### Why `.cargo/config.toml` is at the root and cannot move

Cargo finds it by walking up from the **current directory**, not from the
manifest. Without it, a `cargo build` typed inside this workspace kept walking
into the V1 checkout above it and used *that* config — sending 5.9 GB of output
to a directory outside the tree, while Bazel and `carbon run` looked somewhere
else entirely. It declares
`target-dir = ".tools/orchestration/bazel/cargo/target"`, and the validator
compares that declaration against the two others naming the same path.

---

## 4. Contract Packages (`solutions/contracts/`)

Ten contracts, one directory each, every one carrying a definition, a
`BUILD.bazel` and a `README.md` stating its compatibility policy — which
`//.tools/validation:workspace_test` enforces.

| Contract | Holds | Honoured by |
| :--- | :--- | :--- |
| **`core`** | `core.fbs` — the primitive schemas | every language tier |
| **`app`** | `carbon.toml`: schema, TypeScript types, errors, and the Rust reader | the CLI and the runtime |
| **`plugin`** | the extension-point registry, the C ABI, the manifest, permissions | the runtime and every plugin author |
| **`host`** | `api.fbs` · `events.fbs` · `ipc.fbs` | the host layer |
| **`runtime`** | the `__cm_*` host-boundary registry, and the event vocabulary | JS and Rust, across a boundary no compiler sees |
| **`security`** | keyring shape, signature format, minisign byte lengths | signing and verification |
| **`versioning`** | `versioning.fbs` — compatibility triples | update negotiation |
| **`update`** | what a release announces to an installed app | publishing and updating |
| **`distribution`** | which installer formats exist, and where each may be built | packaging |
| **`toolchain`** | the versions this workspace is built against | bootstrap and CI |

Two of these are checked against reality rather than trusted:
`check_host_boundary.py` compares the `__cm_*` registry against what the Rust
actually registers, and `check_extension_points.py` re-renders the plugin
extension-point registry and fails if the generated C, Rust or TypeScript has
drifted from the Zig that declares it.

---

## 5. Developer Commands & Automation

### Workspace Structure Validation
Validate workspace invariants, directory structure, and clean root rules:
```bash
python .tools/validation/check_workspace.py
```

### Standalone FlatBuffers Binding Generator
Generate C++, Rust, Go, TS, and C# files from `.fbs` schemas:
```bash
python .tools/generators/flatc_generate.py
```

### Environment Bootstrap
Verify installed toolchains (Bazel, Clang, Rust, Zig, Go, Node, .NET):
```powershell
# Windows
.\.tools\automation\bootstrap\setup.ps1

# Linux / macOS
./.tools/automation/bootstrap/setup.sh
```

### Bazel Build & Test Commands
Build all workspace targets:
```bash
bazel build //...
```

Run the CLI. Bazel is the entrypoint; Bun is the runtime, downloaded and pinned
by the toolchain in `.tools/orchestration/bazel/bun/`:
```bash
bazel run  //products/carbon-cli:carbon -- doctor
bazel run  //products/carbon-cli:carbon -- dev ./my-app
bazel test //solutions/internal/ts/updater:rollout_test
```

The equivalent direct invocation is `bun products/carbon-cli/src/main.ts …`.
Both do the same work — see `.tools/orchestration/bazel/bun/README.md` for what
the Bazel wrapper does and does not guarantee.
