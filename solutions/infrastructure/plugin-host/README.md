# carbon/api — the plugin extension surface

Everything about how *external* code safely extends the app. Not to be
confused with [`ecosystem/system/stdlib/api`](../../ecosystem/system/stdlib/api)
(`@carbon/api`, the TypeScript-facing wrapper over `carbon/host/`'s native OS
calls) — that's a different "api" entirely, named before this folder existed.
If you're looking for filesystem/network/shell/clipboard/etc., that's
[`carbon/host/`](../host), not here.

## What's here

- **`host_exports.rs`** — the runtime side of the Carbon plugin C ABI: the
  `CarbonApp` struct and `carbon_js_*` symbols a plugin DLL resolves at load
  time to call back into the host. Layout here MUST match
  `ecosystem/users/sdk/rust/src/ffi.rs` and
  `ecosystem/users/sdk/include/carbon_plugin.h` exactly — order, types,
  alignment.
- **`plugin_loader.rs`** — resolves a plugin's manifest, checks its declared
  capabilities against what `carbon.toml`'s `[plugins]` section grants, and
  dlopens the DLL/so/dylib.

## Why this is separate from `carbon/host/`

Host calls the OS *on the app's behalf* (JS asks for a file, host reads it).
Api defines the boundary *external* plugin code crosses to call back into the
host (a plugin asks to use a capability it was granted, api checks and
dispatches). Same direction of trust as host (native code doing privileged
things), opposite direction of initiative (host is called by the app's own
JS; api is called by code the app didn't write). Keeping them apart means the
capability-gating logic that only applies to *external* code never leaks into
the OS-bridge functions every app depends on unconditionally.

## Why these are `#[path]` includes and not a crate

Same reason as `carbon/host/` — see [`carbon/host/README.md`](../host). Both
`carbon-mini` and `carbon-blitz` include this source directly so the plugin
ABI is inlined into each binary with no indirection, and both backends stay
byte-identical on the ABI they expose.
