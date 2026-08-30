# plugin

What a plugin declares, the places it can plug in, and the binary interface the
host loads it through. Three agreements about one subject, which is why they sit
together.

**Agreements**
- `registry/extension-points.zig` — **every place a plugin can plug in.** The
  source of truth; the three files below are generated from it.
- `abi/carbon_abi.h` — handles, the allocator table, the entry-point struct
- `schema/manifest.fbs` — how a plugin describes itself
- `schema/permissions.fbs` — the capabilities it requests
- `types/PluginManifest.ts` — the TOML form the toolchain reads

**Generated — do not edit**
- `abi/carbon_extension_points.h` — the prototypes a plugin author compiles against
- `rust/generated.rs` — the table the runtime dispatches through
- `types/ExtensionPoints.ts` — what the toolchain validates manifests with

**Honoured by** the host (Rust) and every plugin author (Zig)

**Breaking the ABI** is the worst break in the repository: plugins are shipped
prebuilt, so ones already on disk stop loading. Layout, symbol names and enum
values are frozen once shipped.

## Why the registry is written in Zig

Plugins are written in Zig, so Zig is the one language guaranteed to be present
when a plugin is built. A plugin `@import`s `registry/extension-points.zig`
**directly** and gets its ids and metadata comptime-checked against the same
file the runtime's dispatch table was rendered from. There is no generated code
on the plugin side at all, and therefore no version of the contract that can be
stale there.

The other two parties cannot read Zig — the runtime is Rust, the toolchain is
TypeScript — so they get renderings:

```
        registry/extension-points.zig          ← edit this
                      │
        carbon ext generate
                      │
      ┌───────────────┼────────────────┐
      ▼               ▼                ▼
abi/carbon_       rust/          types/
extension_        generated.rs   ExtensionPoints.ts
points.h
   (plugin)        (runtime)        (toolchain)
```

`.tools/validation/check_extension_points.py` re-renders the registry and fails
if any of the three has drifted, naming the file and the first differing line.
That check is the only thing standing between "one contract in four languages"
and "four contracts" — nothing in a compiler notices, because each rendering is
internally consistent.

## Adding an extension point

1. Append an entry to `POINTS` in `registry/extension-points.zig`. Never reorder
   or remove one — a point's symbol is baked into `.dll`s on other people's
   disks.
2. Set `.since_minor` to the next ABI minor and bump
   `CARBON_PLUGIN_ABI_VERSION_MINOR` in `plugin-sdk/include/carbon_plugin.h`.
3. `carbon ext generate`.
4. **Call it from `products/carbon`.** A declared point the runtime never
   dispatches is a promise to plugin authors that nothing keeps, and nothing
   else in this pipeline will catch that.

Appending is a MINOR bump and breaks nothing: old plugins do not export the new
symbol, the loader finds nothing, and the point is skipped. That is why every
point is individually optional.

## What the runtime enforces

Per plugin, at load, before `lifecycle.register` runs:

| Check | On failure |
|---|---|
| ABI major matches | the plugin is skipped |
| manifest `required` ⊆ the app's grants | skipped, listing what to add |
| each implemented point's `capability` is granted | skipped, naming the point |
| an `exclusive` point is claimed once | the second claimant is skipped, named |
| an `experimental` point is used | loaded, with a warning |
| a declared point that was not exported | loaded, warning that it will not be called |

`carbon plugin check` and `carbon run`'s preflight report the first four from
the toolchain, before the app launches, where the message can name a file to
edit rather than scrolling past in stderr.

## Native target directory names

`carbon/native/<os>/<arch>/` (the staged-plugin output tree — see
`solutions/capabilities/plugin/lifecycle`'s manifest-driven design) needs the
same directory name strings agreed on by three languages: `carbon/build.zig`
(staging), `plugin_loader.rs` (resolving), and the TS lifecycle use cases
(existence checks, `carbon plugin list`). Small enough that a generated
rendering (like the extension-point table above) would be pure overhead — this
is the one canonical table, quoted verbatim by each implementation, with a
comment pointing back here:

| `os` | `arch` |
|---|---|
| `windows` | `x86_64` |
| `linux` | `x86_64`, `aarch64` |
| `macos` | `x86_64`, `arm64` |

Extension (per `os`): `windows` → `dll`, `linux` → `so`, `macos` → `dylib` —
unrelated to `arch`.

## Known compromise

`host.resolve_asset` is declared and **not yet dispatched**. The loader binds
it; `products/carbon` has no asset-resolution path to call it from, so a plugin
implementing it today is never invoked.

It is kept because it is the only point exercising `exclusive` arity and a
non-void return, and dropping it would leave both untested end to end. It is
marked experimental, the loader warns on use, and the "NOT YET DISPATCHED"
note is rendered into all three generated artifacts. Wire it or remove it
before ABI 1.1 ships.

Everything else in the registry has a dispatch site in `products/carbon`.
`carbon-mini` is the only backend that loads plugins at all — `carbon-blitz`
imports the loader and never builds a registry.

## Two manifests, and why

A plugin describes itself twice:

- `carbon_plugin_manifest()` in its Zig source, returning JSON. **The runtime
  reads this.** It is compiled in, so it ships with the binary.
- `carbon-plugin.toml` beside the source. **The toolchain reads this.** It is
  not shipped.

They must agree, and `carbon plugin check` is what verifies they do. The Zig
SDK's `manifest.build` derives the capability list from the extension points a
plugin declares, so the half a human is most likely to get wrong is computed
rather than typed.
