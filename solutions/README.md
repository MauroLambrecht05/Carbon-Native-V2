# solutions/

Everything the products are built out of. Products depend on solutions;
solutions never depend back.

A solution solves one problem, and is product-agnostic: nothing in here knows
that `carbon-cli` exists.

```
solutions/
├── contracts/       agreements between things that must not drift apart
│   ├── core/            core.fbs
│   ├── app/             carbon.toml — schema, types, errors
│   ├── plugin/          the extension points, the C ABI, the manifest
│   ├── host/            api · events · ipc
│   ├── security/        keyring, signature format, minisign byte lengths
│   ├── versioning/      versioning.fbs
│   ├── update/          what a release announces to an installed app
│   ├── distribution/    which installer formats exist, and where each builds
│   └── toolchain/       the versions this workspace is built against
│
├── capabilities/    what carbon can do — grouped by domain, one folder per
│   │                capability inside its category. 21 capabilities outgrew a
│   │                flat list; category is a browsing aid, not the `kind`
│   │                system below — see "Capabilities are grouped twice".
│   │                Every category and every capability is one word, no
│   │                exceptions — including math, which has no capability
│   │                of its own to sit beside otherwise (see below) but does
│   │                not get to sit ungrouped at capabilities/ root either.
│   ├── cloud/            Carbon Cloud's own domain — accounts, billing, the
│   │   ├── billing/          build queue, the worker side of it
│   │   ├── orchestration/
│   │   ├── worker/
│   │   └── identity/
│   ├── distribution/     getting a built app to a user, signed and current
│   │   ├── packaging/        an artifact into an OS installer
│   │   ├── publishing/       announcing a release and shipping its artifacts
│   │   ├── signing/          proving an artifact came from us
│   │   └── updating/         keeping an install current without bricking it
│   ├── plugin/            authoring, building and loading native plugins
│   │   ├── registry/         the plugin registry, and its C/Rust/TS renderings
│   │   ├── lifecycle/        authoring, building and installing native plugins
│   │   └── sdk/               the Zig SDK's implementation
│   ├── rendering/         the runtime's own paint/layout/media stack
│   │   ├── audio/ · gpu/ · imaging/ · layout/ · painting/ · text/
│   │   ├── math/              pure vector/matrix computation — a library
│   │   │                      (see "kinds" below), filed here because this
│   │   │                      is where its only real consumer lives, not
│   │   │                      because it shares a dependency with its
│   │   │                      neighbors — see "Capabilities are grouped
│   │   │                      twice" for the previous, now-overridden,
│   │   │                      reasoning against exactly this
│   │   └── snapshot/         heap snapshot/restore (FFI, not rendering per
│   │                         se, but consumed by nothing else — see below)
│   └── tooling/           turning source into something runnable
│       ├── bundling/         source into a runnable bundle
│       └── scaffolding/      a name and a preset into a working project
│
├── infrastructure/  vendor-neutral technical services — ports/ + adapters/
│   ├── logging/         the Logger port, and a console adapter
│   ├── process/         the ProcessRunner port, and a node adapter
│   ├── workspace/       where things live, and reading carbon.toml
│   ├── os/              nineteen host-function adapters over the OS
│   ├── platform/        one adapter per target OS
│   └── plugin-host/     the frozen plugin ABI, and the loader
│
├── integrations/    outside technologies, named by ROLE then vendor
│   ├── bundler/vite/       our Vite integration (was nine packages)
│   ├── transpiler/babel/   the carbon-css compiler + app decorator
│   ├── javascript/quickjs/ the vendored rquickjs-core fork
│   ├── terminal/xterm/     an xterm.js-compatible terminal
│   └── scene3d/            three · three-fiber
│
└── interface/       how application code and developers reach the runtime
    ├── cli/             the command framework: Command, Dispatcher, flags, help
    ├── renderer/        solid · react — JSX into scene-graph host calls
    └── stdlib/          api · bindings · dom — the app-facing surface over __cm_*
```

Every tier states its internal shape below, and every package follows the one
its tier declares. Where a package does not, the reason is written down in
that package and holds up to measurement — see the capability kinds, and
`three-fiber`'s missing `domain/`.

## Which tier may depend on which

Not a line — a DAG. This file used to claim the five tiers were "ordered by
dependency direction, each may depend on the ones above it", and measuring the
tree found **22 breaches of that rule, every one of them correct design**: a
capability using a `ProcessRunner` port, `bundling` driving Vite. The rule was
wrong, not the code.

| Tier | May depend on | Because |
|---|---|---|
| `contracts/` | **nothing** | a contract that imports an implementation is not one |
| `infrastructure/` | contracts | a technical service that knows which business calls it is not a service |
| `integrations/` | contracts | same |
| `capabilities/` | contracts, infrastructure, integrations | this is where business logic composes the rest |
| `interface/` | anything | the driving edge — and **nothing may depend on it** |

`.tools/validation/check_workspace.py` enforces this. The two rules with teeth
are the outer ones: contracts import nothing, and nothing imports `interface/`.
The middle rows mostly describe what already happens.

## Two languages, one tree

`solutions/` holds Rust and TypeScript side by side, and the tier a thing
belongs to does not depend on its language. `capabilities/rendering/audio` is
Rust, `capabilities/distribution/signing` is TypeScript, and both are
capabilities for the same reason: they are what carbon does.

Rust crates are built through `//.tools/orchestration/bazel/cargo`, TypeScript
through `//.tools/orchestration/bazel/bun`. Neither tier knows.

## Capabilities come in three kinds

`capabilities/` was doing too much as one category — it holds `signing`
(business logic), `math` (a vector library), `snapshot` (pure FFI) and
`plugin-sdk` (a distributable), and "what carbon does" is true of all four
while discriminating between none.

Measuring which product consumes each one separated them almost perfectly:

| consumed by | shape | count |
|---|---|---|
| the **CLI** | use-case shaped | 6 of 6 |
| the **runtime** | flat / algorithmic | 7 of 9 |

So a capability declares its `kind` — in `package.json` under `carbon.kind`,
or as `# carbon-kind` in `Cargo.toml`:

| kind | what it is | the rule with teeth |
|---|---|---|
| **service** | the toolchain doing something a developer asked for | has `application/`, and a model — local `domain/` **or** a contract |
| **engine** | a subsystem the runtime composes to run an app | may not depend on a service |
| **library** | pure computation, no knowledge of carbon | may not depend on anything carbon |

This replaced the claim that "every capability follows the same internal
shape", which was false: half of them did not, and every exception was
correct. One shape was being asserted over three kinds of thing.

The rules are about **dependencies**, not directories, and that took two
attempts to get right. The first version required every service to have a
local `domain/`; `bundling`, `packaging` and `publishing` failed it, and all
three were right — their model is a *contract*, shared with whoever else
speaks it. The second required engines to have no `application/`; `imaging`
failed that, and was also right — a runtime engine can still have one genuine
use case. Directory presence was never the invariant.

## Capabilities are grouped twice, on two different axes

`kind` (above) and the `cloud/`/`distribution/`/`plugin/`/`rendering/`/
`tooling/` category each capability now sits under (see the tree at the
top) answer different questions, and neither replaces the other:

- **`kind`** is about **dependency rules** — service, engine or library
  decides what a capability is allowed to import, and is declared as
  metadata (`carbon.kind`) precisely so it stays orthogonal to where a file
  happens to live. "The rules are about dependencies, not directories" above
  is still true.
- **category** is about **what the capability is FOR**, purely for a human
  finding it — `cloud/` is Carbon Cloud's own domain regardless of whether
  `billing` (service) or a hypothetical engine in that space would sit
  beside it. It exists because 21 capabilities in one flat list had stopped
  being browsable, not because domain and kind turned out to correlate.

They mostly don't correlate: `rendering/` holds six engines, one FFI
capability (`snapshot`), and one library (`math`) together because they're
all part of the runtime's paint path, not because kind grouped them there.
`math` is the one deliberate exception to "category means the dependency
graph agrees": it isn't consumed by any other capability at all, only
directly by `products/carbon`'s `mini` feature, so filing it under
`rendering/` next to the engines that happen to share its math primitives
asserts a relationship that doesn't actually exist in the dependency
graph. It sits there anyway, because the alternative — a single capability
sitting alone at `capabilities/` root, in no category at all — was judged
worse: one inconsistent placement is a smaller cost than a rule
("category, then capability, always") with an exception baked into the
tree itself. Read `math`'s presence under `rendering/` as "no better home
exists", not "this is where it dependency-wise belongs".

## The service shape

A service — and only a service — follows this:

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

## The other three tiers have shapes too

`capabilities/` was the only tier this file described from the inside, and it
showed: the other three had grown packages that were a directory of loose
files with a 1,700-line `index.ts` in them. Each tier now states its shape,
and `.tools/validation/check_workspace.py` checks the parts with teeth.

### `infrastructure/` — `ports/` and `adapters/`

```
<service>/
├── ports/      the interface this service promises. Omit when there is one
│               implementation and no second candidate to shape it against.
├── adapters/   the implementations — per vendor, per platform, per OS
│               facility. Grouped into subdirectories once there are many:
│               os/adapters/{desktop,filesystem,net,process,storage,…}/
├── tests/
└── index.ts    (TypeScript) or lib.rs (Rust)
```

Two words, in both languages. `os/` had `modules/`, `platform/` had
`targets/`, `plugin-host/` had `loader/` — three names for one idea, and
`modules/` in particular said only that they were Rust modules, which the
`mod` keyword beside it already said. `plugin-host/abi/` keeps its own name
and is the deliberate exception: a port is an interface the service calls
*outward* through, and that is an interface other people's prebuilt binaries
were compiled *against*.

`WorkspaceLayout.ts` sat loose at its package root, which read as "this is
the package" rather than "this is one adapter of two". It walks the
filesystem, so it is an adapter.

### `integrations/` — `domain/` and `infrastructure/`

```
<role>/<vendor>/
├── domain/          what the integration means, with the vendor absent
├── infrastructure/  the vendor-facing code
├── tests/
└── index.ts
```

The same two words `capabilities/` uses, for the same reason. `vite/` already
had it. The others now do:

| Integration | `domain/` holds | `infrastructure/` holds |
|---|---|---|
| `bundler/vite` | the module graph, the Tailwind class table, the theme extractor | the Vite plugins and Babel passes |
| `scene3d/three` | the `DrawCommand` schema — both sides of the JS↔Rust boundary agree on it, so it may drag neither in | the scene-walking renderer, the executors |
| `terminal/xterm` | the escape-sequence parser, the cell grid, the emitter, the xterm.js types | the `Terminal` that paints the grid as scene nodes, and the addons |
| `transpiler/babel` | `styles.css` → a `class -> styleProps` map | the Babel visitor that rewrites JSX, and the `.csx` pre-processor |
| `scene3d/three-fiber` | — | everything: the intrinsic registry, the renderer, the builder, `<Canvas>` |

`three-fiber` has no `domain/` and that is a measurement, not an omission:
every file in it imports three.js, so the directory would be a label rather
than a boundary. **Where nothing is vendor-free, `domain/` is omitted rather
than invented** — the same honesty the capability kinds are built on.

`javascript/quickjs` is exempt entirely: it is a vendored upstream fork
(`Cargo.toml.orig` and all), and it keeps rquickjs's layout so the diff
against upstream stays readable.

### `interface/` — named for what the surface is made of

The driving edge has no single shape, because a command framework and a
React reconciler are not the same kind of thing. What each package does have
is directories named for a role, and no file loose at the root except
`index.ts`:

```
interface/cli/              kernel/ · ports/ · adapters/ · dispatch/
interface/renderer/<vendor> host/ · scene/ · styling/ · reconciler/ · runtime/ · testing/
interface/stdlib/api        host/ · bridge/ · process/ · storage/ · system/ · window/
interface/stdlib/bindings   bridge/ · desktop/ · filesystem/ · net/ · process/ · storage/ · system/ · window/
interface/stdlib/dom        shims/ · globals/
```

Two things are load-bearing here:

**The two renderers have the same shape.** `react/` and `solid/` were a
1,730-line and a 1,091-line `index.ts` solving the same problem twice, and
comparing them meant scrolling both. They now carry the same six directory
names, so a fix in one has an obvious address in the other. `solid/` has one
the other does not — `intrinsics/`, for `<canvas>` and `<image>`, which React
reaches through props on a host component instead.

**`stdlib/bindings` and `infrastructure/os` use the same eight area names.**
That is the same boundary seen from its two sides, so a host function and its
TypeScript wrapper are always in same-named directories, and "where does this
new binding go" answers itself.

Everything else follows from "no loose files": `stdlib/dom`'s `install.ts`
was 1,376 lines, of which the streams polyfill and four installers touched
nothing but `globalThis` and are now their own modules; what remains is
what genuinely needs `document` and `window` in one closure.

## The plugin architecture crosses every tier

Worth reading as one path, because no single directory holds it:

| Tier | Holds |
|---|---|
| `contracts/plugin/` | `registry/extension-points.zig` — **the source of truth**, plus the C, Rust and TS renderings generated from it |
| `capabilities/plugin/registry/` | parsing that Zig, and rendering the three |
| `capabilities/plugin/sdk/` | the Zig SDK's implementation — the surface is `products/carbon-ext` |
| `capabilities/plugin/lifecycle/` | scaffold, build, check, install, preflight |
| `infrastructure/plugin-host/` | the loader: dlopen, bind by symbol, enforce capabilities, dispatch |
| `products/carbon-ext` | the SDK itself: the C ABI header, the templates, the package definition |
| `products/carbon-cli` | every command: `carbon plugin *`, `carbon ext *`, and the preflight `carbon run` calls |
| `products/carbon` | the dispatch sites — where each point is actually called |

The rule that shapes it: **a plugin is a shared library that exports C symbols,
and the export is the registration.** No callback table, no register call. That
is what makes every point individually optional, and appending one to the
registry a MINOR ABI bump rather than a break.

The direction is enforced the usual way — `contracts/plugin/rust` depends on
nothing, so the generated table names an opaque `CarbonApp` and the host casts
its own descriptor to it at the dispatch site.

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

## TypeScript projects are not one project

Most of the tree typechecks under `solutions/tsconfig.json`. Five packages
cannot, and each carries its own `tsconfig.json`:

| Package | Needs | Why |
|---|---|---|
| `interface/renderer/solid` | lib DOM, `--jsx` | solid-js's own types name DOM |
| `interface/renderer/react` | lib DOM, `--jsx` | react-reconciler's do too |
| `integrations/terminal/xterm` | lib DOM | it is API-compatible with xterm.js, whose surface is `HTMLElement` |
| `integrations/scene3d/three` | lib DOM | three.js's declarations name it |
| `integrations/scene3d/three-fiber` | lib DOM, `--jsx` | both |

Those options must not reach the rest of the tree: carbon has **no DOM**, and
with `lib DOM` in scope a stray `document.getElementById` compiles cleanly and
fails at runtime.

`interface/stdlib/dom` is the pointed exception — it implements those globals,
so giving it `lib DOM` would collide with its own declarations. It declares the
one type it needs (`BufferSource`) locally instead.

Run them all with `.tools/validation/check_typescript.py`, which discovers
projects rather than listing them. It found a stale `include` on its first run.

## Why integrations are named by role

`integrations/bundler/vite/`, not `integrations/vite/`. The directory says what
the thing is *for*, and the vendor is a leaf. A payment integration is
`payment/stripe`, a database one is `database/postgres`. Swapping a vendor then
changes one leaf rather than a name that appears throughout the tree.

## Known compromises

These are half-steps, marked so they are not mistaken for finished work:

- **`packaging/` produces definitions, not installers.** The generators emit
  an NSIS `.nsi`, a WiX `.wxs`, a Debian `control` file — the INPUT a packaging
  tool consumes. Producing a `.exe`/`.msi`/`.deb` needs makensis, the WiX
  toolset or dpkg-deb installed, and `carbon bundle` says so rather than
  implying it built one.
- **`publishing/` uploads nothing.** `BuildUpdateManifestUseCase` produces a
  contract-valid manifest, but `platforms` is empty because no artifact is
  signed, hashed or uploaded yet. `carbon publish` warns instead of reporting
  a publish that did not happen.
- **`Bundler` is declared but unused.** `BuildProjectUseCase` imports
  `BunBundler` directly rather than taking the port. The interface names the
  seam; threading it through is separate work. `Logger` and `ProcessRunner`
  *are* now injected.
- **`usecases/` in `bundling/` export functions, not classes.** They hold one
  use case each, but the bodies are the ported V1 functions. Newer capabilities
  (`scaffolding`, `lifecycle`, `publishing`) use classes with `execute()`.

## Cold start

`index.ts` deliberately does not re-export `BunBundler.ts`. Evaluating it costs
~68 ms because it pulls in the Vite plugin chain, and `BuildProjectUseCase`
imports it lazily at the point of use. Reach for `@carbon/bundling/bundler` if
you genuinely need it.
