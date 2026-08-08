# runtime

The JavaScript ↔ Rust boundary: every function name passed between the two
languages.

**Agreement** `registry/host-boundary.toml`
**Honoured by** `infrastructure/os` and `products/carbon` on the Rust side;
`interface/renderer/{solid,react}` and the stdlib packages on the JavaScript
side
**Enforced by** `.tools/validation/check_host_boundary.py`

## Why this is the most important contract in the repository

Every other contract here describes data. This one describes *names*, and names
are the only thing holding the two halves of the runtime together.

The runtime installs 139 functions onto a QuickJS context. JavaScript calls them
by string. Thirty-four more go the other way — JavaScript installs them, Rust
calls them — and Rust calls those from inside an evaluated JS string literal:

```rust
"globalThis.__cm_dispatch_click && globalThis.__cm_dispatch_click({});"
```

Nothing in the toolchain can see across that. `rustc` sees a string literal.
`tsc` sees a global it was told about in a hand-maintained `declare global`
block. A typo, a rename, or a function dropped during a refactor produces **no
build error on either side** — just an app that silently stops responding to
clicks.

Before this file existed, the entire agreement was: matching string literals in
two languages, and a comment in `hosts.ts` asking people to remember.

## Two directions

```
[imports.*]     Rust installs, JS calls.        139 functions, grouped by module.
[dispatchers]   JS installs, Rust calls.        34 functions.
```

The second direction is not documented anywhere in V1. It is also the more
dangerous one, because the Rust side of it is not Rust — it is JavaScript
inside a string.

The rule separating the lists: a name Rust both **registers and calls** is an
import — that is Rust reading back something it owns, like `__cm_app_name`. A
**dispatcher** is referenced by Rust and registered by Rust nowhere.

Fifteen names looked like dispatchers until that rule was applied. They are
imports.

## What the checker does

Scans the Rust for two things — quoted names (registrations) and every mention
(including inside evaluated JS) — and compares both against this file:

- a declared import that Rust no longer registers → the JS call now hits
  `undefined`
- a registered function that is not declared → the surface grew without anyone
  writing it down
- a declared dispatcher that Rust never calls → an event that stopped being
  delivered

```
python .tools/validation/check_host_boundary.py              # this workspace
python .tools/validation/check_host_boundary.py --source ../V1
```

Verified to fail on both a dropped import and a mistyped dispatcher, rather
than trusted to.

## Blast radius

A **wire break**, in the strongest sense: renaming an import breaks every app
already built against it, and the failure appears at runtime in the user's
hands rather than at build time on ours.

Adding is safe. Renaming and removing are not, and there is no deprecation path
today — an app calls the global or it does not.

## Known gap

`hosts.ts` in the stdlib declares **69** of the 139 imports. The rest are
called without a type declaration, or not called from the stdlib at all (the
scene-graph functions belong to the renderers). Reconciling that — deciding
which side owns each name, and generating both sides from this registry rather
than checking them — is the natural next step, and is not done.
