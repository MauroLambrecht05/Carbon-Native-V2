# @carbon/term — parked, not migrated

An Ink-compatible terminal renderer, built on Solid's universal renderer.

## Why it is in labs/ and not interface/

**It targets a runtime that no longer exists.** Every host function it declares
is `__ct_*`:

```ts
declare const __ct_create_node: (id: number, tag: string, propsJson: string) => void;
declare const __ct_create_inline_text: (id: number, text: string) => void;
```

and its own header points at `archive/runtimes/term/src/main.rs`. That runtime
is in V1's `.local/attic/runtimes/term`. Zero of these names appear in
`solutions/contracts/runtime/registry/host-boundary.toml`, which is the live
boundary — the shipping runtime speaks `__cm_*`.

Filing it under `interface/` would have claimed it works against the runtime
this repository builds. It does not.

## A real bug, found and deliberately not fixed

```ts
// We forward all props including children.
return renderer.createElement(tag, props as any) as any;
```

`createElement` takes **one** argument — in solid-js's universal renderer
interface and in carbon's own `interface/renderer/solid`. The second argument is
silently dropped, so the intrinsic components have never forwarded props, and
the comment above the line says the opposite.

Left as-is on purpose. Fixing it means deciding how props reach a node in a
renderer whose host layer is archived, and that is inventing behaviour rather
than migrating it. The typecheck error is the record.

## To revive it

Point it at the `__cm_*` boundary, add its host functions to
`contracts/runtime`, and fix the `createElement` call. Then it belongs in
`interface/stdlib/`.
