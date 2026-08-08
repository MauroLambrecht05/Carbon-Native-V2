#!/usr/bin/env bun
// `just tree` — what the repository looks like to someone opening it for the
// first time, with the rule that decides what goes where.

const TREE = `
carbon-native/
│
├── runtime/     ── code that runs when the APP runs. This is what ships.
│   ├── mini/         carbon-mini · tiny-skia + taffy + fontdue + rquickjs
│   │   ├── native/       the Rust engine
│   │   ├── renderers/    Solid + React universal renderers
│   │   └── bindings/     TS declarations for its host imports
│   ├── blitz/        carbon-blitz · stylo + parley + vello   [experimental]
│   ├── host/         native host API both backends include (fs net shell pty …)
│   ├── features/     compiled into a backend: audio · image · math
│   ├── plugins/      loaded at runtime over the C ABI: sdk · clipboard
│   └── stdlib/       what an app imports: api · three · term · compat
│
├── tooling/     ── code that runs when you BUILD. Never ships.
│   ├── cli/          the carbon command
│   ├── vite/         build plugins        babel/    build transforms
│   ├── editor/       ts-plugin · vscode   testing/  shared test fixtures
│   ├── vendor/       checksummed third-party release binaries
│   └── scripts/      benchmarks/ · ci/ · setup/ · fonts/
│
├── shared/      ── contracts BOTH of the above depend on.
│   ├── schema/       carbon.toml JSON Schema — the source of truth
│   ├── ts/           @carbon/shared — config · paths · backend registry
│   ├── core/         the Rust manifest parser + IPC envelope
│   └── signer/       ed25519 signing        updater/  A/B update client
│
├── local/       ── nothing here is source. Entirely gitignored.
│   └── target/ · archive/ · docs/ · examples/
│
├── .config/     ── every config file: justfile · rust/ · typescript/
│
└── package.json  bun.lock     the only config the root keeps (Bun requires it)
`;

console.log(TREE);
console.log(`Three source trees, one question:

    "When does this code run?"

    …when the app runs   -> runtime/
    …when you build      -> tooling/
    …both                -> shared/

Anything generated or machine-local goes in local/. See CONTRIBUTING.md.
`);
