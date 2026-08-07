# products/

Shipping deliverables. One directory per product, and every one has the same
shape.

```
products/<name>/
├── README.md          what it is, how to run it, how it is released
├── package.json       the product's own manifest
├── tsconfig.json      extends .config/tsconfig.base.json
├── BUILD.bazel        its Bazel targets
├── main.ts            entrypoint — wiring only, no logic
│
├── composition/       the wiring: what concrete things get built and injected
├── presentation/      driving adapters — how a user reaches in
│   ├── framework/         the surface's plumbing (dispatch, routing, rendering)
│   └── commands/          …or routes/, screens/ — the surface itself
│
├── config/            defaults the product ships with
├── assets/            static resources it ships (icons, templates, fonts)
├── docs/              anything longer than the README
└── tests/             product-level tests: does the assembled thing work
```

## The rule that shapes it

**A product has no `domain/` and no `application/`.** Those layers live in
`solutions/`. A product does exactly two things:

1. **compose** — decide which concrete adapters get wired to which ports
2. **present** — give a human a way to reach the use cases

If you find yourself writing a business rule inside `products/`, it belongs in
a solution. If you find yourself writing a user interface inside `solutions/`,
it belongs in a product. That single test settles almost every placement
question, including the one that recurs most: a CLI, an HTTP API and a GUI are
all *driving* adapters and belong to the product; a filesystem, a key format
and an object store are *driven* adapters and belong to a solution's
`infrastructure/`.

## The slots

| Slot | Holds | Omit when |
|---|---|---|
| `main.ts` | The entrypoint. Builds the graph, hands off, exits. | never |
| `composition/` | Registries, containers, bootstrap. The only place that names every concrete type. | never |
| `presentation/` | The driving adapter. `framework/` is its plumbing; `commands/`, `routes/` or `screens/` is the surface. | a headless product |
| `config/` | Defaults shipped with the product, not user config. | nothing to configure |
| `assets/` | Icons, templates, fonts — files that ship but are not code. | ships no resources |
| `docs/` | Design notes, runbooks, release process. | the README covers it |
| `tests/` | Does the assembled product work — smoke and end-to-end. Unit tests belong beside the code they cover, in `solutions/`. | never |

**Unused slots are omitted, not created empty.** An empty `assets/` teaches
nothing and makes the tree noisier. The table is the contract for where a thing
goes *when* you have one.

## Why `presentation/framework/` and not a shared package

`carbon-cli`'s framework — `Command`, `Dispatcher`, `CommandRegistry`, flag
parsing, help rendering — is generic enough that a second CLI could use it.
It stays here anyway, because right now there is exactly one CLI and moving it
to `solutions/` would mean the toolchain ships a user interface.

When a second product needs it, it graduates to a solution. Keeping it in
`presentation/framework/` rather than scattered through `commands/` is what
makes that move mechanical rather than an excavation.

## Worked example: carbon-cli

```
products/carbon-cli/
├── main.ts                        builds the Dispatcher, runs it
├── composition/
│   └── registry.ts                every command, declared lazily
├── presentation/
│   ├── framework/                 Command · Dispatcher · Registry · Flags · Help · Io
│   └── commands/
│       ├── project/               init · create
│       ├── build/                 build · run · dev · bundle
│       ├── release/               signer · publish
│       ├── plugins/               plugin
│       └── diagnostics/           doctor
└── tests/
    └── registry.test.ts           the assembled command set is coherent
```

Everything those commands *do* — building, signing, packaging, updating — is
`@carbon/toolchain`. The product only turns argv into a use-case call and an
exit code.

## The other product directories

`carbon`, `carbon-builder`, `carbon-studio`, `carbon-cloud`, `carbon-hub` and
the rest are empty placeholders. They take this shape when they get code; until
then they are names, not products.
