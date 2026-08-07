# solutions/

Everything the products are built out of. Products depend on solutions;
solutions never depend back.

A solution solves one problem, and is product-agnostic: nothing in here knows
that `carbon-cli` exists. The five tiers below are ordered by dependency
direction — each may depend on the ones above it, never on the ones below.

```
solutions/
├── contracts/       agreements between things that must not drift apart
│   ├── core/            core.fbs
│   ├── app/             carbon.toml — schema, types, errors
│   ├── plugin/          the C ABI, the manifest, permissions
│   ├── host/            api · events · ipc
│   ├── security/        keyring, signature format, minisign byte lengths
│   ├── versioning/      versioning.fbs
│   ├── update/          what a release announces to an installed app
│   ├── distribution/    which installer formats exist, and where each builds
│   └── toolchain/       the versions this workspace is built against
│
├── capabilities/    what carbon can do — one folder per capability
│   ├── signing/         proving an artifact came from us
│   ├── updating/        keeping an install current without bricking it
│   ├── scaffolding/     a name and a preset into a working project
│   ├── plugins/         authoring, building and installing native plugins
│   ├── bundling/        source into a runnable bundle
│   ├── packaging/       an artifact into an OS installer
│   └── publishing/      announcing a release and shipping its artifacts
│
├── infrastructure/  vendor-neutral technical services, behind ports
│   ├── logging/         the Logger port, and a console adapter
│   ├── process/         the ProcessRunner port, and a node adapter
│   └── workspace/       where things live, and reading carbon.toml
│
├── integrations/    outside technologies, named by ROLE then vendor
│   ├── bundler/vite/    our Vite integration (was nine packages)
│   └── transpiler/babel/  the carbon-css compiler + app decorator
│
└── interface/       shared presentation
    └── cli/             the command framework: Command, Dispatcher, flags, help
```

Every capability follows the same internal shape:

```
<capability>/
├── domain/          the model and its rules — no I/O of any kind
│   ├── entities/        things with identity and a lifecycle
│   ├── value-objects/   things defined entirely by their value
│   ├── services/        rules that belong to no single entity
│   ├── repositories/    interfaces for how the model is stored
│   └── errors/          why this capability refuses
├── application/
│   ├── ports/           what the use cases need from the outside world
│   └── usecases/        one file per thing the capability does
├── infrastructure/  the adapters — a filesystem, a byte format, a store
├── tests/           integration tests, crossing the layers
└── index.ts         the public surface
```

## The layers

**`domain/`** — the model and its rules, and nothing else. No filesystem, no
process, no TOML parser. `validateManifest` takes an already-parsed object, so
the manifest rules can be exercised against a literal; `SlotState` is a state
machine that does not know where it is stored; `PluginsSection` edits a TOML
`[plugins]` table as lines, and never opens a file.

**`application/`** — `ports/` declares what the use cases need from the outside
world; `usecases/` is one file per thing the capability does.

**`infrastructure/`** — the implementations, named for what they actually
adapt: `MinisignKeyStore`, `NodeProjectFileSystem`, `S3ArtifactStore`.

Dependencies point inward, and this is enforced.
`.tools/validation/check_workspace.py` reads every import line under `domain/`
and fails on one that reaches into `application/`, `infrastructure/`, or a
library that ties the model to a runtime:

```
[FAIL] domain imports outward: .../domain/entities/_probe.ts -> /infrastructure/
```

## Why the CLI is not in here

Infrastructure holds **driven** adapters — things a use case calls outward to.
A filesystem, a key format, a process, an object store. The solution owns the
interface and the adapter is interchangeable.

A command line is a **driving** adapter: it is how a human reaches in. It is
also the product's entire reason to exist — `carbon-cli` *is* that surface.

So the split is: **what the toolchain does is a solution; how a developer asks
for it is the product.** `interface/cli/` holds the framework — `Command`,
`Dispatcher`, `CommandRegistry`, flags, help, `Io` — because that is reusable
presentation machinery; the commands themselves live in the product.

The same rule decides future cases. An HTTP API for `carbon-cloud` is a driving
adapter and belongs to that product. A Postgres adapter behind a repository
interface is driven, and belongs in `infrastructure/`.

## Why integrations are named by role

`integrations/bundler/vite/`, not `integrations/vite/`. The directory says what
the thing is *for*, and the vendor is a leaf. A payment integration is
`payment/stripe`, a database one is `database/postgres`. Swapping a vendor then
changes one leaf rather than a name that appears throughout the tree.

## Known compromises

These are half-steps, marked so they are not mistaken for finished work:

- **`packaging/` is dead code.** Nothing invokes the installers. `carbon
  bundle` validates its `--target` against `contracts/distribution` and reports
  what it *would* build; it does not call a generator. Inherited from V1, and
  the command says so rather than claiming success.
- **`publishing/` uploads nothing.** `BuildUpdateManifestUseCase` produces a
  contract-valid manifest, but `platforms` is empty because no artifact is
  signed, hashed or uploaded yet. `carbon publish` warns instead of reporting
  a publish that did not happen.
- **`scaffolding/` and `plugins/` point at directories that do not exist.**
  Generated projects depend on `<root>/packages/mini-runtime`, and plugin
  templates are read from `<root>/packages/carbon-sdk`. Neither has existed
  since V1. Preserved deliberately — where V2 keeps its runtime and plugin SDK
  is an open decision, and pointing them somewhere plausible would bury it.
  See `PackagesPath.ts` and `SdkTemplateSource.ts`.
- **`Bundler` is declared but unused.** `BuildProjectUseCase` imports
  `BunBundler` directly rather than taking the port. The interface names the
  seam; threading it through is separate work. `Logger` and `ProcessRunner`
  *are* now injected.
- **`usecases/` in `bundling/` export functions, not classes.** They hold one
  use case each, but the bodies are the ported V1 functions. Newer capabilities
  (`scaffolding`, `plugins`, `publishing`) use classes with `execute()`.

## Cold start

`index.ts` deliberately does not re-export `BunBundler.ts`. Evaluating it costs
~68 ms because it pulls in the Vite plugin chain, and `BuildProjectUseCase`
imports it lazily at the point of use. Reach for `@carbon/bundling/bundler` if
you genuinely need it.
