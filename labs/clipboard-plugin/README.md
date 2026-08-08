# carbon-clipboard

A Carbon plugin that exposes the OS clipboard to JS with a Web-Clipboard-API
shape. The first end-to-end Layer-2 plugin built against
[`carbon-plugin-sdk`](../carbon-sdk/) — also serves as a worked example /
reference plugin for SDK consumers.

```
import { read, write } from "carbon:clipboard";

await write("hello");
const text = await read();   // → "hello"
```

Backed by [`arboard`](https://crates.io/crates/arboard) for cross-platform
clipboard access (Win32 OleClipboard / NSPasteboard / X11 selection /
Wayland wl-clipboard).

---

## Status

| Feature              | v1            | TODO          |
|----------------------|---------------|---------------|
| Read text            | ✓             |               |
| Write text           | ✓             |               |
| Image clipboard      | —             | needs binary FFI |
| HTML / RTF clipboard | —             | needs format negotiation |
| Clipboard-changed events | —         | arboard has no watch API on Windows yet |

---

## Installing

In your app's `carbon.toml`:

```toml
[plugins.clipboard]
capabilities = ["clipboard.read", "clipboard.write"]
```

The runtime refuses to load the plugin if either capability is missing.
There is no "read-only" mode in v1 — declare both, or don't use the plugin.

The build plugin (`@carbon/vite-imports`) ALSO checks that
`clipboard` appears in `[plugins]` before resolving `import "carbon:clipboard"`.
If the import is present but the section isn't, the build fails with a
clear error pointing at the offending file.

---

## API

### `read(): Promise<string>`

Returns the current clipboard text. Rejects with an `Error` if:

- The clipboard is empty (`empty clipboard` from arboard)
- The clipboard contains non-text data (image, file list, etc.)
- The OS denied access (rare; macOS may prompt on first use)

### `write(text: string): Promise<void>`

Replaces the clipboard contents with `text`. Rejects with an `Error` if:

- The OS denied access
- `text` is not a string (TypeScript will catch this at build time, but the
  runtime guard rejects too — defensive against dynamic JS)

Both functions are safe to call before the first user interaction. macOS
may surface a permission prompt on first call from a sandboxed bundle.

---

## How it works

```
┌──────────────┐   import { read } from "carbon:clipboard"
│  user code   │ ──────────────────┐
└──────────────┘                   │
                                   ▼  (build time, vite plugin)
                  ┌────────────────────────────────────┐
                  │ export const read =                │
                  │   globalThis.__carbon_clipboard_   │
                  │     read_async;                    │
                  └────────────────────────────────────┘
                                   │
                                   ▼  (runtime, on register)
                  ┌────────────────────────────────────┐
                  │ globalThis.__carbon_clipboard_     │
                  │   read_async = (...) => Promise(…) │  ← PROMISE_BOOTSTRAP eval
                  │ globalThis.__carbon_clipboard_     │
                  │   read = JSON-string FFI ───────┐  │
                  └─────────────────────────────────┼──┘
                                                    │
                                                    ▼
                              ┌────────────────────────┐
                              │ arboard::Clipboard     │  (thread_local)
                              │   .get_text()          │
                              └────────────────────────┘
```

Two layers because the SDK's `set_global_function` hands the JS callback a
JSON-encoded args string and expects a JSON-encoded result. That's awkward
for a Promise-returning API, so the plugin installs the raw helpers AND
evals a tiny JS bootstrap (~30 lines) that wraps each in `new Promise(...)`.

The `__carbon_error` sentinel is how the sync side signals an error to the
async wrapper — a plain JSON string couldn't convey "this should reject".

---

## Building

```
cd plugins/clipboard
cargo build --release
```

Produces:

| Platform | Output                                          |
|----------|-------------------------------------------------|
| Windows  | `target/release/carbon_clipboard.dll`           |
| macOS    | `target/release/libcarbon_clipboard.dylib`      |
| Linux    | `target/release/libcarbon_clipboard.so`         |

Typical Windows release build size: **~220 KB** (well under the SDK's
500 KB target).

Verify the link surface is clean (no host-only symbols):

```
# Windows
dumpbin /DEPENDENTS target/release/carbon_clipboard.dll
dumpbin /EXPORTS    target/release/carbon_clipboard.dll
# Should show only system DLLs (kernel32, user32, …) and exports
# `carbon_plugin_register` + `carbon_plugin_manifest`.

# Linux / macOS
nm -D --defined-only libcarbon_clipboard.so | grep carbon_plugin_
ldd libcarbon_clipboard.so
```

---

## Testing

```
cargo test
```

Tests cover:

1. The manifest serializes to the JSON shape carbon-mini's loader expects.
2. Capability strings are stable (`clipboard.read` / `clipboard.write`).
3. Argument parsing rejects wrong shapes cleanly.
4. The result-buffer encoder fits and overflows correctly.
5. The `.toml` manifest agrees with the Rust manifest.

The OS clipboard itself is NOT exercised in tests — arboard's X11 backend
hangs without a display server, which would break CI. End-to-end testing
requires loading the DLL through carbon-mini once the loader lands.

---

## Files

```
carbon-clipboard/
├── Cargo.toml             cdylib + rlib, deps on carbon-plugin-sdk + arboard
├── carbon-plugin.toml     build-tool manifest (modules + exports table)
├── README.md              this file
├── src/
│   └── lib.rs             register + manifest + JS callbacks + bootstrap eval
└── tests/
    └── integration.rs     manifest schema + capability strings
```
