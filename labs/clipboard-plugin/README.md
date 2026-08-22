# carbon-clipboard

The reference Carbon plugin. Small enough to read in one sitting, and it
exercises every part of the plugin architecture a real plugin uses.

```ts
import { read, write } from "carbon:clipboard";

await write("hello");
const text = await read();   // → "hello"
```

## What it demonstrates

| Part | Where |
|---|---|
| A comptime manifest whose capability list is derived | `MANIFEST` in `src/main.zig` |
| Two extension points | `carbon_plugin_register`, `carbon_ext_window_theme_changed` |
| The comptime id + symbol assertion | the `comptime { }` blocks |
| JS globals installed across the C ABI | `setGlobalFunction` in register |
| An eval'd bootstrap turning sync helpers into Promises | `PROMISE_BOOTSTRAP` |
| Capabilities for the plugin's own work, not a point's | `clipboard.read` / `clipboard.write` |

## Build and install

```bash
zig build
carbon plugin check          # manifest vs. the extension-point registry
carbon plugin install        # copies in, and declares it in carbon.toml
```

The host app must grant what it asks for:

```toml
[plugins.clipboard]
capabilities = ["clipboard.read", "clipboard.write"]
```

## Platform support

Windows only, via Win32 `OpenClipboard` / `GetClipboardData`. The previous Rust
version got macOS and Linux for free from the `arboard` crate; a Zig plugin has
no equivalent, and hand-writing NSPasteboard and X11 backends is a lot of code
that teaches nothing about plugins. Elsewhere both calls reject with
"unsupported on this platform" — the plugin still loads, and a real clipboard
plugin would fill them in.

## Why it is a Zig plugin now

Carbon plugins are Zig — see
[`solutions/capabilities/plugin/sdk/README.md`](../../solutions/capabilities/plugin/sdk/README.md).
This was the last Rust one, and porting it was part of that change.
