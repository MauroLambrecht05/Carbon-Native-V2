# plugin-sdk

The **implementation** of the Carbon plugin SDK. The SDK itself — the surface
an author touches and the package definition that makes it one — is
[`products/carbon-ext`](../../../products/carbon-ext), because that is a
shipping deliverable and this is the detail behind it.

What is here: `CarbonApp` and the JS helpers, the comptime manifest builder,
the extension-point helpers, cross-thread events. What is there: the C ABI
header, the scaffold templates, `build.zig`.

Plugins are **Zig**; the runtime loads the resulting `.dll` / `.so` / `.dylib`
at startup and calls into it across a C ABI.

```bash
carbon plugin new my-plugin
cd my-plugin
zig build
carbon plugin check              # verify the manifest against the registry
carbon plugin install            # copy into the host app and declare it
```

---

## Quick reference

| What | Where |
|---|---|
| The extension points | `solutions/contracts/plugin/registry/extension-points.zig` |
| The C ABI | `products/carbon-ext/presentation/include/carbon_plugin.h` |
| Generated per-point prototypes | `solutions/contracts/plugin/abi/carbon_extension_points.h` |
| The Zig SDK implementation | `zig/src/` — `carbon_sdk.zig`, `extension_points.zig`, `manifest.zig` |
| The package definition | `products/carbon-ext/composition/build.zig` |
| Starter project | `products/carbon-ext/presentation/templates/plugin/` |
| A worked example | `labs/clipboard-plugin/` |

---

## How a plugin works

A plugin is a shared library that **exports C symbols**. After loading it, the
runtime looks up each symbol the extension-point registry names. A symbol it
finds is a point the plugin implements; one it does not find is a point the
plugin does not take part in. There is no registration call and no callback
table — the export *is* the registration, which is why every point is
individually optional and why appending one to the registry breaks nothing.

The scaffolded `src/main.zig`:

```zig
const std = @import("std");
const sdk = @import("carbon_sdk");

const MANIFEST = sdk.manifest.build(.{
    .name = "my-plugin",
    .version = "0.1.0",
    .points = &.{"lifecycle.register"},
    .modules = &.{"carbon:my-plugin"},
});

export fn carbon_plugin_manifest() callconv(.c) [*:0]const u8 {
    return MANIFEST;
}

comptime {
    const point = sdk.ext.expect("lifecycle.register");
    std.debug.assert(std.mem.eql(u8, point.symbol, "carbon_plugin_register"));
}

export fn carbon_plugin_register(app_raw: *sdk.RawApp) callconv(.c) void {
    const app = sdk.CarbonApp.fromRaw(app_raw);
    if (!app.abiCompatible()) return;
    _ = app.setGlobalString("hello_from_my_plugin", "world");
}
```

The `comptime` block is the part worth understanding. A wrong extension-point
id, or an `export fn` whose name does not match the one the registry expects,
**compiles perfectly** and produces a plugin that loads and is never called.
That block turns both into build errors.

## Why Zig, and only Zig

- A plugin is a C-ABI shared library. `export fn ... callconv(.c)` *is* that.
- `@cImport` reads `carbon_plugin.h` directly, so the SDK does not hand-mirror
  the ABI. The Rust SDK had a whole `ffi.rs` doing exactly that — a second
  source of truth for a frozen contract.
- **The extension-point registry is Zig.** A plugin `@import`s the contract
  file itself and gets comptime-checked ids and metadata from the same
  declaration the runtime's dispatch table was generated from. No other
  language gets that without a generated binding that can go stale.
- `zig build` cross-compiles to every target Carbon ships, from any host.

The Rust SDK was removed. A `carbon-plugin.toml` still saying `language =
"rust"` reads without error — the toolchain falls back to Zig — and then fails
at `build.zig` not existing, which is the message that actually helps.

## Adding an extension point to your plugin

Two edits: add the id to `.points` in the manifest, and export its symbol.

```bash
carbon ext list                        # every point, one line each
carbon ext show window.theme_changed   # the full signature, and the Zig to write
```

`carbon plugin check` then verifies the manifest against the registry: unknown
ids, capabilities a point needs that the manifest does not request, and
experimental points all get reported before the app is ever launched.

## Capabilities

A point may gate on a capability the **host app** must grant in its
`carbon.toml`:

```toml
[plugins.my-plugin]
capabilities = ["paint.pixmap"]
```

`sdk.manifest.build` derives those from the points you declare, so
`paint.before` contributes `paint.pixmap` without you writing it down. The
`.required` field is for capabilities your plugin needs for its *own* work —
the clipboard example uses it for `clipboard.read` and `clipboard.write`, which
no extension point knows about.

The runtime refuses to load a plugin whose required capabilities are not
granted, and refuses per-point too: exporting `carbon_plugin_before_paint` is
asking to write the framebuffer whether or not the manifest said so.

## Layout

```
plugin-sdk/
└── zig/src/
    ├── carbon_sdk.zig         CarbonApp, the JS helpers
    ├── extension_points.zig   the registry, re-exported + comptime checks
    ├── manifest.zig           the comptime manifest builder
    └── push.zig               cross-thread events
```

`zig/src/` keeps its `src/` — that is Zig's convention and what the scaffolded
template emits, and it is the one exception the workspace validator makes.

The header, the templates and `build.zig` used to sit here too. They moved to
`products/carbon-ext` when it became clear the SDK is a deliverable rather than
a capability: what a plugin author downloads is a product, and what is left
here is the code behind it.
