# carbon-plugin-sdk

The contract between **carbon-mini** (the runtime kernel) and **native plugins**
(audio, image, GPU, HTTP, …). Plugin authors compile against this SDK; the
runtime loads the resulting `.dll` / `.so` / `.dylib` at startup and dispatches
lifecycle hooks across the C ABI.

If you're new here, read `../../docs/architecture/ARCHITECTURE_RULES.md` first — it explains
which features belong in the runtime (Layer 1), which become plugins (Layer 2),
and which are pure JS (Layer 3) or build-time transforms (Layer 4). For a
guided walkthrough of writing a plugin, see
[`../../docs/plugins/PLUGIN_AUTHOR_GUIDE.md`](../../docs/plugins/PLUGIN_AUTHOR_GUIDE.md). For
distribution and `carbon add <plugin>`, see
[`../../docs/plugins/PLUGIN_MARKETPLACE.md`](../../docs/plugins/PLUGIN_MARKETPLACE.md).

---

## Quick reference

| Layer | What | Where |
|-------|------|-------|
| The C contract | `carbon_plugin.h` | `include/carbon_plugin.h` |
| Rust SDK | `carbon-plugin-sdk` crate | `rust/` |
| Zig SDK | `carbon_sdk` module | `zig/` |
| Templates | starter projects | `rust/templates/`, `zig/templates/` |
| Smoke test | ABI round-trip | `rust/tests/abi_compat_test.rs` |

---

## Authoring a plugin in Rust

```bash
carbon plugin new my-plugin --lang rust
cd my-plugin
carbon plugin build --release
carbon plugin install         # copies into the host app's plugins/ dir
```

The scaffolded `src/lib.rs` looks like this:

```rust
use carbon_plugin_sdk::{capability::{Capability, Manifest}, carbon_plugin, CarbonApp};

fn register(app: &mut CarbonApp) {
    let _ = app.set_global_string("hello_from_my_plugin", "world");
}

fn manifest() -> Manifest {
    Manifest::new("my-plugin", "0.1.0")
        .require_capability(Capability::FsRead)
        .module("carbon:my-plugin")
        .hook("register")
}

carbon_plugin! {
    register: register,
    manifest: manifest,
}
```

The `carbon_plugin!` macro generates the two C ABI exports
(`carbon_plugin_register`, `carbon_plugin_manifest`) plus any optional
lifecycle hooks you opt into. It also wraps every entry point in
`std::panic::catch_unwind` so a panicking plugin can't unwind across the
language boundary (which is UB on Windows MSVC).

Optional hooks supported by the macro:

```rust
carbon_plugin! {
    register: register,
    manifest: manifest,
    before_reload: my_before_reload,         // fn(&mut CarbonApp)
    after_reload:  my_after_reload,          // fn(&mut CarbonApp)
    before_paint:  my_before_paint,          // fn(&mut CarbonApp, &mut [u8], u32, u32, u32)
    after_paint:   my_after_paint,           // fn(&mut CarbonApp)
    on_resize:     my_on_resize,             // fn(&mut CarbonApp, u32, u32)
    on_shutdown:   my_on_shutdown,           // fn(&mut CarbonApp)
}
```

Hooks you don't list are simply not exported, and the runtime treats their
absence as "this plugin doesn't implement that hook."

### What you get on `CarbonApp`

* `app.abi_version()` / `app.abi_compatible()` — runtime version handshake.
* `app.app_name()`, `app.app_version()`, `app.project_dir()`, `app.window_id()`.
* `app.window_size()`, `app.raw_window_handle()`, `app.raw_display_handle()`.
* `app.set_global_string(name, value)` — install a string on `globalThis`.
* `app.set_global_number(name, value)`.
* `app.set_global_function(name, callback)`.
* `app.eval(source)` — bootstrap-only; prefer setting globals.
* `app.push_event(name, json_payload)` — cross-thread → JS handler.
* `app.request_paint()`.

### Pushing events from a background thread

The audio plugin's analyser feeds visualization data this way:

```rust
use carbon_plugin_sdk::push;

std::thread::spawn(move || {
    loop {
        let payload = serde_json::to_string(&fft_buffer()).unwrap();
        // The CarbonApp pointer is `Send` once you've stashed it as
        // `*mut ffi::CarbonApp` (after asserting the runtime keeps it alive).
        let _ = push::push_event_raw(app_ptr, "audio.analyserData", &payload);
    }
});
```

The runtime drains pushed events on the JS thread and invokes
`globalThis.__carbon_on_event(name, json_payload_string)`.

### Capabilities

A plugin's `Manifest` declares which capabilities it needs. The runtime
parses the manifest before calling `register` and refuses to load the
plugin if a `required` capability isn't granted by the host app's
`carbon.toml [plugins]` block. Built-in identifiers:

| Capability | Meaning |
|------------|---------|
| `fs.read` / `fs.write` | Filesystem access (within the app's globs) |
| `audio.output` / `audio.input` | Speakers / microphone |
| `image.decode` | Image-decode helpers |
| `gpu` | wgpu / D3D / Metal / Vulkan |
| `network` | Outbound sockets / HTTP |
| `system.ui` | Notifications, dialogs, tray |
| `clipboard.read` / `clipboard.write` | OS clipboard |

Custom strings (e.g., `com.example.my-cap`) are supported via
`Capability::Custom`.

---

## Authoring a plugin in Zig

```bash
carbon plugin new my-plugin --lang zig
cd my-plugin
zig build
carbon plugin install
```

The Zig SDK exposes the same C ABI through `@cImport("carbon_plugin.h")`
plus a thin `carbon_sdk` module with helpers. See
`zig/templates/plugin/src/main.zig.tmpl` for the scaffolded entry point.

> **Status note:** the Zig SDK is shipped as a working `cdylib` template
> wrapping the C ABI directly. It deliberately stays smaller than the
> Rust SDK — the manifest builder is a comptime-formatted JSON string
> rather than a typed builder. We'll grow it as Zig plugins materialize.

---

## Authoring a plugin in pure C / C++

You can compile straight against `include/carbon_plugin.h` without using
either language SDK. Implement the required entry points and link as a
shared library:

```c
#include "carbon_plugin.h"

static const char* MANIFEST_JSON =
    "{"
    "\"name\":\"my-c-plugin\",\"version\":\"0.1.0\","
    "\"abi_version_major\":1,\"abi_version_minor\":0,"
    "\"capabilities\":{\"required\":[],\"optional\":[]},"
    "\"modules\":[],\"lifecycle_hooks\":[\"register\"]"
    "}";

void carbon_plugin_register(CarbonApp* app) {
    if (app->abi_version_major != CARBON_PLUGIN_ABI_VERSION_MAJOR) return;
    carbon_js_set_global_string(app->js_ctx, "hello_from_c", "world");
}

const char* carbon_plugin_manifest(void) { return MANIFEST_JSON; }
```

---

## Stable-ABI rules (for SDK contributors)

These rules govern changes to `carbon_plugin.h`:

1. **Append-only**: new function pointers go at the end of `CarbonApp`,
   never inserted in the middle.
2. **Append-only entry points**: new optional hooks added by name, never
   by reusing an old name with a different signature.
3. **No C++ features**: `carbon_plugin.h` must compile under
   `gcc -std=c99 -Wpedantic`. No `inline`, no `constexpr`, no anonymous
   structs in struct fields, no fixed-array fields with non-literal sizes.
4. **Bump rules**:
   * Append a field or hook → bump `MINOR`.
   * Change any existing signature, struct field type, or enum value →
     bump `MAJOR` and force every plugin to recompile.

The Rust SDK's `ffi.rs` mirrors `carbon_plugin.h` by hand. When you change
one, change the other in the same commit. The Zig SDK's `c.zig` is auto-
imported via `@cImport`, so it tracks the header file directly.

---

## Files in this directory

```
include/
  carbon_plugin.h           THE CONTRACT (pure C, language-agnostic)
rust/
  Cargo.toml                carbon-plugin-sdk crate
  src/
    lib.rs                  Safe wrappers + carbon_plugin! macro
    ffi.rs                  Hand-mirrored declarations from carbon_plugin.h
    push.rs                 Cross-thread event helpers
    capability.rs           Manifest builder + Capability enum
  templates/plugin/         Scaffold for `carbon plugin new --lang rust`
  tests/
    abi_compat_test.rs      Smoke test for the macro + accessors
zig/
  build.zig
  build.zig.zon
  src/
    carbon_sdk.zig          Zig wrappers + manifest comptime helper
    push.zig                Cross-thread event helper
  templates/plugin/         Scaffold for `carbon plugin new --lang zig`
tests/
  README.md                 Pointer to the Rust integration test
```
