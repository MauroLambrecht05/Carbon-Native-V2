# Repository Structure & Architecture Rules

This document is the complete, portable rulebook for one repository layout —
a ports-and-adapters monorepo split into **products** (what ships) and
**solutions** (what products are built from). It is not tied to any one
product, language, or build tool. Replace `<scope>` with your own package
scope (e.g. `@acme/*`), and `App` with your project's name, and the rest
applies as written.

**Audience: an AI agent (or a developer) that needs to place new code
correctly, without re-deriving the rules from scratch.** Every rule below is
either load-bearing (breaking it produces a wrong architecture) or explicitly
marked as convention (breaking it produces inconsistency, not wrongness).
Section 6 is the fast path — if you already know the two-tier split and just
need to place one thing, start there.

---

## 1. The one-sentence version

**A product composes and presents. A solution decides and does. Nothing else
is a rule — everything else is a consequence of that one.**

Two questions settle almost every placement decision:

1. **"Am I writing a business rule, or a way for something outside the
   system to reach in?"** A business rule → `solutions/`. A way to reach in
   (CLI command, HTTP route, button, window) → `products/`.
2. **"Is this thing reached *from* outside (driving), or does it reach *out*
   to something outside (driven)?"** Driving (a human, another system,
   calling in) → presentation. Driven (a database, filesystem, vendor API,
   called out to) → infrastructure.

If you can answer those two questions, you can place the code. Everything
below exists to make the answer mechanical instead of a judgment call.

---

## 2. Top-level layout

```text
repo/
├── <build-root-files>          # whatever your build tool needs at the root
├── README.md                   # points here, plus how to build/run/test
├── .config/                    # configuration, and nothing that is not
├── .tools/                     # developer automation that never ships
├── .local/                     # design-rationale notes: WHY a decision was
│                                # made, not what the code does (the code
│                                # already says that). Committed.
├── labs/                       # experiments — disposable contents,
│                                # permanent directory
├── products/                   # shipping deliverables
└── solutions/                  # everything products are built from
```

Generated output (build artifacts, lockfiles that aren't the source lockfile,
downloaded toolchains) lives **beside whatever produces it**, and every such
directory is gitignored. Do not invent a top-level `dist/`, `build/`, or
`out/` that collects output from unrelated places — that is how a repository
ends up with a build folder nobody can explain and nothing points at
consistently.

### `.config/` — configuration, and nothing that is not

Package manifests, lockfiles, path-alias / workspace config, feature flags,
per-platform build profiles, toolchain version pins. If a new file here isn't
configuration something else reads, it doesn't belong here.

### `.tools/` — developer automation that never ships

Bootstrap scripts, CI scripts, release scripts, structure validators, code
generators. A rule of thumb: if you deleted `.tools/` entirely, the shipped
product would still work — only development and release would be harder.

### `labs/` — experiments

- May depend on `solutions/`. **Nothing may depend on `labs/`.**
- An experiment that earns its place graduates to `solutions/` or
  `products/`; it does not grow roots here.
- Broken/unused experiments get deleted, not carried forward "in case."
- The directory itself always exists, even empty — so an experiment always
  has somewhere to go that isn't `products/` or `solutions/`.

### `.local/` — why, not what

Design notes: why a decision was made, what was tried and rejected, what a
migration changed and why. Not API docs (the code + its own README already
say what it does) — this is the layer that answers "why does it look like
this" six months later. Committed to the repo despite the name.

### Why there's no package manifest at the root

Most JS/TS package managers resolve dependencies by walking **up** from the
importing file. If your manifest lives in `.config/`, a package there is
invisible to `products/` and `solutions/` unless something makes it visible
— either a generated symlink/junction at the root pointing into
`.config/node_modules`, or (better, and what this layout actually uses)
**path aliases in a shared base config**, not a `workspaces` array. Internal
imports (`@scope/thing`) are compiler path mappings, not installed packages —
there is no `workspace:*` dependency anywhere. Every tree that imports
`@scope/*` needs its own build config extending the shared base, because
resolution happens relative to the *importing* file.

This matters because it changes how you wire a new package in: you add one
line to the shared path-alias map, not an entry in a workspaces array.

---

## 3. `products/` — shipping deliverables

One directory per product. Every product has the same shape, whether it's a
CLI, a desktop app, a web service, or a library deliverable (an SDK with no
`main.ts` at all is still a product — see §3.4).

```text
products/<name>/
├── README.md          what it is, how to run it, how it's released
├── package.json        the product's own manifest
├── tsconfig.json        extends the shared base config
├── <build-file>          its build targets
├── main.ts               entrypoint — wiring only, no logic
│
├── composition/       the wiring: what concrete things get built and injected
├── presentation/      driving adapters — how something reaches in
│   ├── framework/         the surface's own plumbing (dispatch, routing,
│   │                       windowing, rendering — whatever the surface needs)
│   └── <surface>/          commands/, routes/, screens/, windows/ — the
│                            surface itself, named for what it actually is
│
├── config/            defaults the product ships with (not user config)
├── assets/            static resources it ships (icons, templates, fonts)
├── docs/               anything longer than the README
└── tests/               product-level tests: does the assembled thing work
```

### 3.1 The rule that shapes everything here

**A product has no `domain/` and no `application/`.** Those layers live in
`solutions/`. A product does exactly two things:

1. **compose** — decide which concrete adapters get wired to which ports
2. **present** — give something outside a way to reach the use cases

If you find yourself writing a business rule inside `products/`, it belongs
in a solution. If you find yourself writing UI/surface code inside
`solutions/`, it belongs in a product. **No `src/` either** — layers sit at
the product root, not nested under a generic "source" directory.

### 3.2 The slots

| Slot | Holds | Omit when |
|---|---|---|
| `main.ts` | The entrypoint. Builds the graph, hands off, exits. | never (for a runnable product) |
| `composition/` | Registries, containers, bootstrap. The only place that names every concrete type. | never |
| `presentation/` | The driving adapter. `framework/` is its plumbing; the named surface folder is the actual thing a user touches. | a headless product with nothing reaching in |
| `config/` | Defaults shipped with the product, not user config. | nothing to configure |
| `assets/` | Icons, templates, fonts — files that ship but are not code. | ships no resources |
| `docs/` | Design notes, runbooks, release process. | the README covers it |
| `tests/` | Does the assembled product work — smoke and end-to-end. Unit tests belong beside the code they cover, in `solutions/`. | never |

**Unused slots are omitted, not created empty.** An empty `assets/` teaches
nothing and makes the tree noisier. This table is the contract for where a
thing goes *when* you have one — not a checklist to pre-create.

### 3.3 A product's `presentation/` is not one shape

A command-line surface and a windowed GUI are not the same kind of thing, so
`presentation/` doesn't have one fixed internal vocabulary across all
products — but every product's own `presentation/` should be internally
consistent:

| Product kind | `presentation/framework/` holds | The surface folder holds |
|---|---|---|
| CLI | Command base class, dispatcher, flag parsing, help rendering, an `Io` port for output | one folder per command group |
| Desktop app | Window/event-loop plumbing, a screen router | `screens/` — the actual screens/views |
| Desktop app (OS chrome) | — | `shell/` — tray icon, dock/menu bar, deep-link handlers, single-instance lock. Still a *driving* adapter: the OS reaching in, same category as a click or a typed command, not a new top-level concept. |
| Web service | Router/middleware plumbing | `routes/` (or `http/`) — the actual endpoints |
| Extension/plugin host | Activation plumbing | commands/contributions the host exposes |

Generic OS registration that the app does *to itself* at boot (register as
default handler, request auto-launch-at-login) is composition, not
presentation — it's the app telling the OS about itself, not something
reaching in.

### 3.4 A product need not be a program

A product can be a library deliverable — an SDK, a header + templates, a
build-plugin package — with no `main.ts` and no commands. It still needs the
two slots that matter: `presentation/` is what a consumer of the SDK
touches, and `composition/` is whatever wires the surface to its
implementation in `solutions/` (a build script, a package manifest — the
composition root doesn't have to be a file called `main.ts`, it has to be
*a* place that names every concrete piece).

A product manifest-only surface (e.g. an editor extension whose manifest
*is* its activation contract, with no script this repo runs) is exempt from
the rest of the template for the same reason: there's nothing to wire and
nothing beyond what its own packaging tool already checks.

### 3.5 One surface, one owner

If two products would both need "a CLI," that's one product (the CLI) with
two command groups, not two half-CLIs. Functionality organizes around what
kind of surface it is, not around which feature area asked for it.

### 3.6 When `presentation/framework/` graduates to a solution

Generic surface plumbing (a command dispatcher, a router) starts inside the
one product that needs it, even though it's reusable in principle. It moves
to `solutions/interface/` **only when a second product actually needs it** —
not preemptively. Keeping it in its own `framework/` folder rather than
scattered through the surface folders is what makes that later move
mechanical instead of an excavation.

### 3.7 The one earned exception: product-owned `infrastructure/`

The two-verb rule (compose + present) is deliberately strict, but real
products accumulate **driven** adapters that are genuinely specific to that
one product and have no second consumer yet — a web dashboard's own
database connection, its own HTTP route table serving its own API. Per the
strict rule those belong in a solution's `infrastructure/`; in practice,
until there's a second consumer, promoting them there is premature
abstraction.

The resolution: a product may earn a third top-level folder,
`infrastructure/`, sibling to `composition/` and `presentation/`, for driven
adapters owned by that product alone:

```text
products/<name>/
├── composition/
├── presentation/
├── infrastructure/
│   ├── http/          the API this product's own dashboard/service exposes
│   └── persistence/    its own database connection + migrations
└── tests/
```

This is **earned, not pre-built** — don't scaffold it on day one "in case."
Add it the day you have a real product-specific driven adapter, using the
same reasoning as §3.6: it graduates out to `solutions/` the day a second
product needs the same thing.

---

## 4. `solutions/` — everything products are built from

Products depend on solutions; **solutions never depend back.** A solution
solves one problem and is product-agnostic — nothing in here should know
that any particular product exists.

```text
solutions/
├── contracts/       agreements between things that must not drift apart
├── capabilities/    what the app can do — the business logic, by domain
├── infrastructure/  vendor-neutral technical services — ports/ + adapters/
├── integrations/     outside technologies, named by ROLE then vendor
└── interface/         how application code and users reach the system
```

### 4.1 Dependency direction — a DAG, not a line

It is tempting to say "each tier may depend on the ones before it in the
list above." Measure it and that claim breaks — a capability legitimately
needs a `ProcessRunner` port from infrastructure, an integration legitimately
gets driven by a capability. **What's actually true:**

| Tier | May depend on | Because |
|---|---|---|
| `contracts/` | **nothing** | a contract that imports an implementation is not one |
| `infrastructure/` | contracts | a technical service that knows which business logic calls it is not a service |
| `integrations/` | contracts | same reasoning |
| `capabilities/` | contracts, infrastructure, integrations | this is where business logic composes the rest |
| `interface/` | anything | the driving edge — and **nothing may depend on it** |

The two rules with teeth, worth enforcing mechanically: **contracts import
nothing**, and **nothing imports `interface/`**. The middle rows mostly
describe what naturally happens once those two hold.

### 4.2 `contracts/` — agreements that must not drift

A contract is a schema, a wire format, an ABI, a manifest shape — anything
two or more independent things (possibly in different languages) must agree
on byte-for-byte. It imports nothing, ever; a "contract" that pulls in an
implementation has stopped being an agreement and started being a
dependency.

```text
contracts/<subject>/
├── <definition>        the schema file — .fbs, .json schema, a header, a
│                        generated-types file — whatever your format is
├── BUILD               its build target
└── README.md            what it promises, and its compatibility policy
```

Split by subject (e.g. `contracts/core/`, `contracts/api/`,
`contracts/security/`), not by consumer — a contract doesn't know who reads
it.

### 4.3 `capabilities/` — what the app can do

Business logic, grouped by domain. This is the tier with the most internal
structure, because "business logic" is not one shape — a payment-processing
service, a rendering engine, and a pure math library are all "capabilities"
and none of them should be forced into the same directory shape.

**Capabilities come in three kinds**, declared as metadata (e.g.
`"kind": "service"` in the manifest) rather than inferred from folder names,
so the kind stays orthogonal to where a file happens to live:

| kind | what it is | the rule with teeth |
|---|---|---|
| **service** | does something a user/developer asked for | must have `application/`, and a model — a local `domain/` **or** a shared contract |
| **engine** | a subsystem the runtime composes to do its job, with no direct external ask | may not depend on a service (that would invert the dependency direction — the render path can't need the thing that publishes releases) |
| **library** | pure computation, no knowledge of the app at all | may not depend on anything app-specific — must be swappable for an off-the-shelf package |

**A service is a model with two hands** — it looks at the world through
`domain/`'s rules and reaches out through `application/`'s use cases:

```text
<capability>/
├── domain/          the model and its rules — no I/O of any kind
│   ├── entities/        things with identity and a lifecycle
│   ├── value-objects/   things defined entirely by their value
│   ├── services/        rules that belong to no single entity
│   ├── repositories/    interfaces for how the model is stored
│   └── errors/          why this capability refuses
├── application/
│   ├── ports/            what the use cases need from the outside world
│   └── usecases/         one file per thing the capability does
├── infrastructure/  the adapters — a filesystem, a byte format, a store
├── tests/            integration tests, crossing the layers
└── index.ts          the public surface
```

**`domain/` may not import `application/`, `infrastructure/`, or any
library that ties it to a concrete runtime.** This is the load-bearing rule
of the whole layout and should be checked mechanically (grep every import
line under every `domain/`, fail on one reaching outward). `domain/` should
be exercisable against a plain literal in a test with zero setup — if it
needs a database or a file on disk to test, it has stopped being domain
logic.

**A service needs a model, but not necessarily a *local* one.** If two
services share the same model, that model belongs in `contracts/`, not
duplicated into each service's own `domain/` to satisfy a directory check. A
service with genuinely no model anywhere (no `domain/`, no contract
reference) is the actual violation — not the missing folder by itself.

**An engine may have a genuine, narrow `application/`** — "load an asset,
capability-checked first" is a legitimate single use case inside something
that is otherwise algorithmic. What's forbidden isn't the directory, it's
depending on a service.

**A library is defined by replaceability.** The moment it imports anything
app-specific, it has become a capability wearing a library's clothes — move
it or stop calling it a library.

#### Grouping capabilities

Once there are more than a handful, group them by **category** — a purely
human browsing aid (`payments/`, `notifications/`, `rendering/`), separate
from `kind` (which governs dependency rules). These two groupings answer
different questions and don't have to correlate: a library can sit inside a
category next to services and engines because that's where its only real
consumer lives, not because it shares dependency rules with its neighbors.
One word per category, one word per capability name, no ungrouped leftovers
sitting alone at `capabilities/` root once categories exist.

### 4.4 `infrastructure/` — vendor-neutral technical services

Driven adapters with no business knowledge: logging, a process runner,
filesystem access, OS-facility wrappers, one adapter per target platform.

```text
<service>/
├── ports/      the interface this service promises. Omit when there is
│               exactly one implementation and no second candidate to shape
│               it against.
├── adapters/   the implementations — per vendor, per platform, per OS
│               facility. Grouped into subdirectories once there are many.
├── tests/
└── index.ts
```

Two words, always. Don't invent a third name for "the implementations" per
package (`modules/`, `targets/`, `loader/` are all just `adapters/` wearing
a disguise) — one vocabulary lets "where does the new adapter go" answer
itself without checking each package's local convention.

### 4.5 `integrations/` — outside technologies, named by role then vendor

```text
<role>/<vendor>/
├── domain/          what the integration MEANS, with the vendor absent
├── infrastructure/  the vendor-facing code
├── tests/
└── index.ts
```

**Named by role, then vendor** — `payment/stripe`, not `stripe/`. The
directory says what the thing is *for*; the vendor is a leaf. Swapping
vendors later changes one leaf, not a name that appears throughout the tree.

`domain/` is omitted, not invented, when nothing about the integration is
vendor-free — if every file in it imports the vendor SDK, the directory
would be a label rather than a real boundary. Say so, don't fake a
boundary that doesn't exist.

A vendored upstream fork (code you're carrying with minimal changes to track
someone else's project) is exempt from this shape entirely — keep its
original layout so diffing against upstream stays readable.

### 4.6 `interface/` — how application code and users reach the system

The driving edge has no single fixed shape across packages, because a
command framework and a UI-rendering reconciler are not the same kind of
thing. What every package here has in common:

- Directories named for a **role**, not a generic label
- **Nothing loose at the package root** except the public entrypoint
  (`index.ts`)
- Two packages solving the *same* problem (two renderers for two UI
  frameworks, two client bindings for two languages) should share the same
  internal directory vocabulary, so a fix in one has an obvious address in
  the other.

### 4.7 Why a CLI (or any user-facing surface) lives in `products/`, not `solutions/interface/`

`infrastructure/` holds **driven** adapters — things a use case calls
*outward* to (a filesystem, a key format, a database). The solution owns the
interface; the adapter is interchangeable.

A CLI, an HTTP API, a GUI are **driving** adapters — how something reaches
*in*. And a driving adapter is usually also the product's entire reason to
exist. So: **what the system does is a solution; how someone asks for it is
a product.** The reusable *framework* behind a driving adapter (a dispatcher,
a router) can live in `solutions/interface/` once it has more than one
consumer — but the actual commands/routes/screens stay in the product,
because those are what makes that product what it is.

---

## 5. Where does X go? (fast decision table)

| You're adding... | Goes in | Why |
|---|---|---|
| A new business rule / validation | `solutions/capabilities/<x>/domain/` | it's the model, not a way to reach it |
| A new use case ("do the thing") | `solutions/capabilities/<x>/application/usecases/` | one file per thing the capability does |
| A new CLI command | `products/<cli>/presentation/<group>/` | driving adapter, product-owned surface |
| A new UI screen/window | `products/<app>/presentation/screens/` | driving adapter |
| A new OS tray/menu/deep-link handler | `products/<app>/presentation/shell/` | still driving — the OS reaching in |
| A new HTTP endpoint | `products/<service>/presentation/routes/` (or a solution's `interface/` once ≥2 products share the framework) | driving adapter |
| A filesystem/database/key-store adapter used by ONE capability | `solutions/capabilities/<x>/infrastructure/` | driven, capability-owned |
| A filesystem/process/logging port used by MANY capabilities | `solutions/infrastructure/<service>/` | driven, vendor-neutral, shared |
| A wrapper around a third-party SDK/vendor API | `solutions/integrations/<role>/<vendor>/` | named by role then vendor |
| A schema/format two things must agree on | `solutions/contracts/<subject>/` | imports nothing, ever |
| Pure computation with zero app knowledge | a `library`-kind capability, or promote it out entirely if literally app-agnostic | must be swappable for an off-the-shelf package |
| Something ONE product needs and nothing else will ever use (its own DB, its own route table) | `products/<name>/infrastructure/` | the earned exception — see §3.7 |
| A quick spike / proof of concept | `labs/<name>/` | disposable, nothing depends on it |
| A config default the product ships with | `products/<name>/config/` | not user config |
| An icon/font/template the product ships | `products/<name>/assets/` | ships, but isn't code |
| A design-rationale note (why, not what) | `.local/` | not API docs |

If a row doesn't fit: ask the two questions from §1. Business rule vs. way
to reach in. Driving vs. driven. That resolves it.

---

## 6. Adding a new feature — step by step

Worked example: adding a capability called `notifications` (send a message
through some channel), consumed by a CLI command and a background job.

1. **Does this need a contract?** Only if something else — another
   capability, a different language, a stored format — must agree on its
   shape byte-for-byte. If not, skip this step; its model lives locally.

2. **Decide the kind.** `notifications` does something a user asked for
   (`service`) — not an always-on subsystem (`engine`) and not
   knowledge-free computation (`library`).

3. **Write the domain first, with no I/O.**
   `solutions/capabilities/notifications/domain/`
   - `entities/Notification.ts` — identity, state (queued/sent/failed)
   - `value-objects/Channel.ts` — email vs. push vs. SMS, as a closed value
   - `errors/NotificationError.ts` — why this refuses (bad address, no
     channel configured)
   - Write its tests against literals — no filesystem, no network, in this
     step.

4. **Declare the ports the use cases need.**
   `solutions/capabilities/notifications/application/ports/`
   - `NotificationSender.ts` — an interface: `send(notification): Promise<Result>`
   - The use case doesn't know or care whether this is SMTP, a push
     service, or a fake in a test.

5. **Write the use case.**
   `solutions/capabilities/notifications/application/usecases/SendNotificationUseCase.ts`
   — takes the ports as constructor dependencies, orchestrates domain +
   ports, returns a result. No concrete adapter named anywhere in this file.

6. **Write the real adapter(s).**
   `solutions/capabilities/notifications/infrastructure/SmtpNotificationSender.ts`
   implementing the port. If it's really a third-party vendor's SDK you're
   wrapping (SendGrid, Twilio), that wrapper's *vendor-facing* half belongs
   in `solutions/integrations/messaging/<vendor>/infrastructure/` instead —
   `notifications/infrastructure/` then just adapts *that* integration to
   the capability's own port.

7. **Export the public surface.**
   `solutions/capabilities/notifications/index.ts` — the use case, a
   `createNotificationsUseCase()` convenience wired to real adapters, the
   port types, the error types. This is the only thing a product imports.

8. **Wire it in the product that needs it.**
   `products/<cli>/composition/registry.ts` adds the new command;
   `products/<cli>/presentation/notifications/send.command.ts` turns argv
   into a call to `createNotificationsUseCase().execute(...)` and prints the
   result. No business logic here — if you're tempted to write an `if`
   about *whether* to send, that belongs back in the use case.

9. **Test at the right layer.**
   - Domain rules: unit tests, no I/O, inside `solutions/`.
   - The use case wired to fakes: integration tests, inside
     `solutions/capabilities/notifications/tests/`.
   - The assembled command actually working: a product-level test in
     `products/<cli>/tests/`.

10. **Only after a second product needs the same command surface**, consider
    promoting shared presentation plumbing to `solutions/interface/`. Not
    before — see §3.6.

This same ten-step shape applies whether the "product" is a CLI, a desktop
app, or a web service — only step 8's target folder changes.

---

## 7. Bootstrapping a brand-new repository with this structure

Minimum viable skeleton for day one, before any feature exists:

```text
repo/
├── README.md                     # points at this doc, says how to build/run
├── .config/
│   ├── package.json               # third-party deps
│   ├── <lockfile>
│   └── tsconfig.base.json         # @scope/* path aliases start empty
├── .tools/
│   └── validation/
│       └── check_workspace.py     # start with just the tier-DAG + product-
│                                    # template checks; grow it as rules earn
│                                    # their place (see §8)
├── labs/                          # empty, tracked (e.g. a .gitkeep)
├── products/
│   └── README.md                   # this doc's §3, trimmed to your product set
└── solutions/
    ├── README.md                   # this doc's §4, trimmed to your tiers
    ├── contracts/
    ├── capabilities/
    ├── infrastructure/
    ├── integrations/
    └── interface/
```

Do **not** pre-create every capability, every product, or empty
`ports/`/`adapters/` pairs "for later." Every example above of "know the
rule, then measure the tree" found real, correct exceptions to rules that
looked obviously true in the abstract. Start with the tiers and the two
hard-edge rules (contracts import nothing; nothing imports `interface/`);
let the internal shape of each capability/product emerge from what it
actually needs, and write down the exception *with its reasoning* the
moment you find one — that reasoning is what stops the next person from
"fixing" a deliberate asymmetry.

First product, first capability: build the thinnest possible vertical slice
(one command, one use case, one adapter) end-to-end before building a
second one. The second one is what tells you whether your port shapes were
right — the first one alone can't.

---

## 8. Naming & hygiene rules

These are convention, not load-bearing — but consistency here is what makes
"where does this go" answerable by pattern-matching instead of reading
prose every time.

- **One word per category, one word per capability name**, when
  capabilities are grouped into categories.
- **No loose source files at a package root.** Only an entrypoint
  (`index.ts`/`lib.rs`/`main.ts`), a manifest, and prose belong at a
  package's own root. A `.ts` file sitting loose at the root is a file that
  hasn't been given a role yet — give it one: a directory named for what it
  does.
- **No `src/`, anywhere, except for tooling that mandates it** (some
  language ecosystems' own conventions, or scaffolding someone else's
  project where their convention isn't this repo's business). Layers sit at
  the package root directly.
- **One vocabulary per tier**, for tiers that have one (`infrastructure/` =
  `ports/` + `adapters/`; `integrations/` = `domain/` + `infrastructure/`).
  Don't let one package invent `modules/` while its sibling uses
  `adapters/` for the same idea.
- **Integrations are named `<role>/<vendor>/`**, never just `<vendor>/`.
- **A contract package always carries its definition + build target +
  README** stating its compatibility policy. No contract without a stated
  policy for what counts as a breaking change.
- **Products depend on solutions; solutions never depend back. Nothing
  depends on `interface/`. Nothing depends on `labs/`.**
- **Unused slots are omitted, not created empty.** This applies everywhere
  the shape tables above list optional folders.

---

## 9. Enforcement — what a validator script should check

Prose rules drift; a script that runs in CI does not. At minimum, a
workspace validator should mechanically check:

1. **Domain purity**: grep every import line under every `domain/`, fail on
   one importing `application/`, `infrastructure/`, or a runtime-coupling
   library.
2. **Tier DAG**: resolve each internal import to the tier it lives in, fail
   on an edge not in the allowed table (§4.1) — especially: nothing imports
   `interface/`, `contracts/` imports nothing.
3. **Product template**: every product with a runnable manifest has
   `main.ts` + `composition/` + `presentation/` + `tests/`, and has neither
   `domain/` nor `application/` nor `src/`.
4. **Capability shape by kind**: a `service` has `application/` and a model
   (local or contract); an `engine` doesn't depend on a `service`; a
   `library` depends on nothing app-specific.
5. **Contract pattern**: every contract directory has its definition, build
   target, and README.
6. **Package layout**: no loose source at a package root; each tier that
   declares a fixed vocabulary (`infrastructure/`, `integrations/`) has no
   directory outside it; no `src/` in the tree (outside declared
   exceptions).
7. **Declared-tree agreement**: whatever this document (or its per-repo
   equivalent) claims exists at the root/`.config/`/`.tools/` should be
   checked against what's actually on disk, in both directions — nothing
   declared is missing, nothing present is undeclared. A structure doc that
   silently drifts from the tree is worse than no doc.

A failing check should name the exact file/line and the rule it broke, not
just "structure invalid" — the fix is almost always mechanical once the
violation is pinpointed.

---

## 10. Anti-patterns — the mistakes this layout exists to prevent

- **Business logic in `products/`.** The tell: a product file has an `if`
  that isn't about argv/routing/rendering — it's making a *decision* the
  system should make regardless of which surface asked.
- **A UI/CLI surface inside `solutions/`.** The tell: a solution package
  imports a terminal-rendering or DOM/windowing library.
- **`domain/` reaching outward.** The tell: a domain file imports anything
  that would make its unit test need a database, a file, or a network call.
- **A capability's shape assumed instead of measured.** Don't force every
  capability into the `service` shape "for consistency" — an engine with a
  forced `application/` full of non-use-cases, or a library with a
  `domain/` it doesn't need, is worse than an honest, documented exception.
- **Pre-built abstraction with one consumer.** Shared presentation
  framework, a promoted `infrastructure/` port, a contract — all of these
  are *earned* by a second real consumer, not built speculatively because
  "we'll probably need it."
- **A structure document that stops matching the tree.** If a rule changes,
  update the doc in the same change — and prefer a rule enforced by a
  script (§9) over one that only lives in prose, because prose drifts
  silently and a script fails loudly.
- **Fixing a deliberate asymmetry because it "looks inconsistent."** Before
  changing something that looks like drift, check whether it's a documented
  exception with a reason. If it has one, the inconsistency is the correct
  state, not a bug.
