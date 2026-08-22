# interface/renderer

The JavaScript side of rendering: what an app's JSX compiles into.

```
solid/   @carbon/mini-solid — Solid's universal renderer, bound to the
         runtime's scene-graph host functions
react/   @carbon/mini-react — the same surface for React
```

## Why these are interface, not part of painting

They lived under `carbon/runtime/engine/paint/renderers/` in V1, which put them
inside the Rust crate that rasterizes pixels. They are neither Rust nor
rasterization.

A renderer here is a *driving* adapter in the same sense the CLI is: it is how
application code reaches the runtime. `<view style={{...}}>` becomes
`__cm_create_node` / `__cm_set_prop` / `__cm_insert_node` calls, and that
translation is presentation, not the paint engine. `capabilities/rendering/painting` never
imports them — it receives a scene graph that already exists.

Two renderers rather than one is the point of the split: Solid and React
produce the same host calls from different reconciliation models, so the
boundary they share is the host-function surface, not a paint backend.

## Status: migrated, not wired

**These are not built or typechecked yet.** They were moved here in phase 3
because leaving them inside `painting/` would have been wrong, but their
`package.json` aliases, `tsconfig` paths and Bazel targets are phase 6, when the
rest of the TypeScript tier (`stdlib/`) lands with them.

Until then they are source in the right place, and nothing depends on them. See
`products/carbon/MIGRATION.md`.

## The contract they depend on

Both call the `__cm_*` globals the runtime installs — the same 139-function
surface captured in `.tools/validation/baselines/host-functions.txt`. That
surface is matched by string name across an FFI boundary in two languages and
is declared nowhere; `contracts/runtime` in phase 4 is what fixes that, and
these are two of its consumers.
