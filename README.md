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

The workspace strictly enforces a clean tier system. **The workspace root
holds Bazel files and nothing else** — every other config lives in `.config/`.

```
V2/
├── MODULE.bazel                             # Multi-language Bazel Bzlmod configuration
├── BUILD.bazel                              # Root build rules and visibility packages
├── .bazelrc                                 # Compiler flags, platform profiles, caching
├── .bazelversion                            # Pinned Bazel release (bazelisk reads this)
│
├── .config/                                 # Central Project Configuration Registry
│   ├── _identity.json                       # System identity & language ABI metadata
│   ├── build.json                           # Build profiles (debug, release, profile)
│   ├── dependencies.json                    # Toolchain & library version matrix
│   ├── features.json                        # Feature flags (SIMD, zero-copy, Zig plugins)
│   ├── package.json                         # Third-party npm deps for the TypeScript tier
│   ├── bun.lock                             # …and its lockfile
│   ├── tsconfig.base.json                   # @carbon/* path aliases (replaces bun workspaces)
│   ├── platforms/                           # OS configs (windows.toml, linux.toml, macos.toml)
│   └── toolchains/                          # Toolchain specs (cpp, rust, zig)
│
├── .tools/                                  # Developer Automation & Workspace Utilities
│   ├── automation/bootstrap/                # Environment setup + link-node-modules
│   ├── generators/                          # FlatBuffers python binding generator
│   ├── orchestration/bazel/bun/             # The Bun toolchain: bun_binary / bun_test
│   └── validation/                          # Workspace boundary validator (check_workspace.py)
│
├── labs/                                    # Experimental Sandboxes & Polyglot Spikes
│                                            #   (a tier, kept even when empty)
│
├── products/                                # Final Executable Binaries & CLI Applications
│   ├── carbon/                              # Core runtime binary
│   ├── carbon-cli/                          # Developer CLI interface (ported from V1)
│   ├── carbon-builder/                      # Build engine
│   └── carbon-studio/                       # IDE & visual tools
│
└── solutions/                               # Reusable Code, Libraries & Infrastructures
    ├── shared/                              # Shared Public Interfaces (Zero internal dependencies)
    │   ├── contracts/                       # Modular System Contracts & Binary ABIs
    │   │   ├── abi/                         # Native C-ABI Header (carbon_abi.h & BUILD.bazel)
    │   │   ├── api/                         # API Descriptor Contracts (api.fbs & BUILD.bazel)
    │   │   ├── events/                      # System Event Bus Contracts (events.fbs & BUILD.bazel)
    │   │   ├── ipc/                         # Inter-Process Communication (ipc.fbs & BUILD.bazel)
    │   │   ├── manifest/                    # Component & Plugin Manifest (manifest.fbs & BUILD.bazel)
    │   │   ├── permissions/                 # Capability Security & Grants (permissions.fbs & BUILD.bazel)
    │   │   ├── schemas/                     # Core Primitive Schemas (core_types.fbs & BUILD.bazel)
    │   │   ├── security/                    # Crypto Tokens & Signatures (security.fbs & BUILD.bazel)
    │   │   └── versioning/                  # Compatibility & Versioning (versioning.fbs & BUILD.bazel)
    │   │
    │   └── infrastructure/                  # Containerization (docker/Dockerfile, devcontainer/devcontainer.json)
    ├── tsconfig.json                        # extends .config/tsconfig.base.json for this tree
    ├── internal/                            # split by SUBSYSTEM, not by use case
    │   └── toolchain/                       # build · sign · package · ship · update · CLI
    │       └── src/domain · application · ports · infrastructure
    │                                        #   (the runtime subsystem lands beside this,
    │                                        #    migration phases 3-5)
    └── external/                            # integrations with tools we do not own
        └── build-plugins/                   # Babel + Vite plugins applied at build time
```

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
tsconfig nearest the *importing* file — currently `products/carbon-cli/` and
`solutions/`.

---

## 4. Contract Package Taxonomy (`solutions/shared/contracts/`)

The contract layer is organized into 9 independent, self-contained contract packages:

| Contract Package | Location | Primary Responsibility |
| :--- | :--- | :--- |
| **`abi`** | [`contracts/abi`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/abi) | Native C-ABI header definitions (`carbon_abi.h`), function pointers, allocator handles. |
| **`api`** | [`contracts/api`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/api) | High-level API endpoint descriptors and RPC contract schemas (`api.fbs`). |
| **`events`** | [`contracts/events`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/events) | System-wide event bus payload schemas (`events.fbs`). |
| **`ipc`** | [`contracts/ipc`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/ipc) | Cross-process communication & RPC header contracts (`ipc.fbs`). |
| **`manifest`** | [`contracts/manifest`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/manifest) | Plugin and package manifest metadata contracts (`manifest.fbs`). |
| **`permissions`** | [`contracts/permissions`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/permissions) | Security capability flags, permission bitmasks, and grants (`permissions.fbs`). |
| **`schemas`** | [`contracts/schemas`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/schemas) | Core data primitives, vectors, transforms, and memory buffers (`core_types.fbs`). |
| **`security`** | [`contracts/security`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/security) | Cryptographic signatures, auth tokens, and security headers (`security.fbs`). |
| **`versioning`** | [`contracts/versioning`](file:///c:/Users/mauro/Desktop/carbon-native/V2/solutions/shared/contracts/versioning) | Protocol version negotiation and compatibility triples (`versioning.fbs`). |

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
