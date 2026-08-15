# products/

Shipping deliverables. One directory per product, and every one has the same
shape.

| Product | Surface for |
|---|---|
| `carbon` | the runtime an app runs on |
| `carbon-cli` | an app developer: init, run, build, publish, plugin |
| `carbon-ext` | an extension author — the plugin SDK itself |
| `carbon-vscode` | an app developer, in the editor — `.ctsx` syntax highlighting |

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

## A product need not be a program

`carbon-ext` is the plugin SDK: a C header, scaffold templates and a Zig
package definition. A shipping deliverable, which is what this tier means —
but a library, so it has no `main.ts` and no commands.

It still has the two slots that matter. `presentation/` is what an author
touches, and `composition/` is `build.zig`, which names every module and joins
the surface to the implementation in `solutions/capabilities/plugin-sdk` and
the registry in `solutions/contracts/plugin`. That is a composition root in the
same sense `main.ts` is.

`check_workspace.py` applies the `main.ts` requirement only to products
carrying a `package.json`, which is what makes one a Bun program. The rule used
to apply to everything, and carbon-ext was briefly given a `main.ts` to satisfy
it — a second CLI, with its own dispatcher and command registry, for commands
that belonged in `carbon-cli`. **Everything CLI is `carbon-cli`.** Being about
plugins is not a reason for a command to leave.

`carbon-vscode` carries a `package.json` — VS Code requires it, it's the
manifest the extension host reads — but is exempt from the rest of the
template for the same reason carbon-ext once was: it declares `engines.vscode`
rather than a `main.ts`, and activates through `contributes`, not a script
this repo runs. No `composition/`, `presentation/` or `tests/` either; there is
nothing to wire and nothing beyond what `vsce package` already checks.

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

There are none. `carbon-builder`, `carbon-studio`, `carbon-cloud`, `carbon-hub`,
`carbon-marketplace`, `carbon-registry`, `carbon-identity`, `carbon-playground`,
`carbon-templates`, `carbon-updater`, `carbon-docs` and `graphite` used to exist
here as empty directories, which contradicted this file's own rule two sections
up — *unused slots are omitted, not created empty* — and made `products/` read
as twelve unfinished products rather than two finished ones.

They are names on a roadmap, and a roadmap is not a directory tree. When one of
them gets code it gets a directory, in the shape described above.
