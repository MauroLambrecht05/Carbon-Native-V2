#!/usr/bin/env bun
// `bazel run //.tools/automation/ci:tree` — what the repository looks like to
// someone opening it for the first time, with the rule that decides what goes
// where.
//
// Hand-written rather than generated from the filesystem. A `find` dump is a
// list; this is the shape, and the annotations are the part worth reading.
// Keep it in step with solutions/README.md and products/README.md.

const TREE = `
V2/
│
├── products/    ── the shipped binaries. Compose and present, nothing else.
│   ├── carbon/       carbon-mini · carbon-blitz — one Cargo package, two bins
│   │   ├── composition/  what gets built and injected; both entry points
│   │   └── presentation/ host functions, the JS pump, the startup trace
│   └── carbon-cli/   the carbon command — argv in, exit code out
│
├── solutions/   ── reusable code the products compose. Ordered by dependency
│   │             direction: each tier may depend leftward, never rightward.
│   ├── contracts/      agreements. Depend on nothing.
│   │                     runtime/  the 139 host fns + 34 dispatchers
│   │                     plugin/   carbon_abi.h — frozen, ships in the wild
│   │                     app/      carbon.toml: schema + TS + Rust
│   ├── capabilities/   what carbon DOES
│   │                     layout · painting · text · imaging · audio · math
│   │                     snapshot · gpu-canvas · bundling · packaging
│   │                     signing · publishing · updating · scaffolding
│   │                     plugins · plugin-sdk
│   ├── infrastructure/ vendor-neutral technical services
│   │                     os/ (the 19 host modules) · platform · plugin-host
│   │                     logging · process · workspace
│   ├── integrations/   named outside technologies, role-then-vendor
│   │                     javascript/quickjs · bundler/vite · transpiler/babel
│   │                     scene3d/three · terminal/xterm
│   └── interface/      surfaces something reaches carbon through
│                         cli/ (the command kernel) · renderer/{solid,react}
│                         stdlib/ (api · dom · bindings)
│
├── .tools/      ── developer automation. Never ships.
│   ├── orchestration/bazel/  the cargo, bun and checks rules
│   ├── validation/           structure, host boundary, tsconfigs, baselines
│   ├── automation/           benchmarks · ci · bootstrap · release
│   ├── vendor/               checksummed third-party binaries
│   └── .build/               cargo output (CARGO_TARGET_DIR). Gitignored,
│                             and here rather than at the root so nothing
│                             generated lands beside MODULE.bazel.
│
├── labs/        ── experiments and things parked with their reasoning.
│                    examples/ · clipboard-plugin/ · editor/ · term/
│
├── .config/     ── every config file. rust/Cargo.toml · tsconfig.base.json
│                    package.json · bunfig.toml · platforms/ · toolchains/
│
└── MODULE.bazel  BUILD.bazel  .bazelrc  .bazelversion
                  The root holds Bazel's files and the tiers. Nothing else —
                  //.tools/validation:workspace_test enforces it.
`;

console.log(TREE);
console.log(`Two questions, in order:

    "Does this SHIP?"        -> products/
    "Is it REUSED?"          -> solutions/, by what KIND of thing it is
    neither                  -> .tools/ (automation) or labs/ (experiments)

A product composes and presents; it has no domain or application layer. If you
are writing a business rule in products/, it belongs in a solution. If you are
writing a user interface in solutions/, it belongs in a product.

Bazel is the entrypoint: \`bazel test //...\` is what CI runs.
See .github/CONTRIBUTING.md.
`);
