// @carbon/plugin-host — loading native plugins and exposing the host ABI to
// them.
//
// Infrastructure: a driven adapter over `libloading`, plus the C-ABI surface a
// plugin compiles against.
//
// Two files, kept in one crate because plugin_loader calls into host_exports
// to hand each plugin its `HostCarbonApp` vtable — the loader cannot construct
// a plugin without the exports, and the exports have no reason to exist without
// something loading a plugin.
//
//   host_exports   the C-ABI structs a plugin receives: CarbonJSContext,
//                  HostCarbonApp, HostCarbonAppStorage, and the event-loop
//                  proxy a plugin's worker thread pushes events through.
//   plugin_loader  the manifest, the registry, and the cross-platform
//                  dlopen/GetProcAddress dance.
//
// ── ON UserEvent ────────────────────────────────────────────────────────────
// `install_event_loop_proxy` takes an `EventLoopProxy<UserEvent>` so a plugin
// running on its own thread can post back to the main loop. That type comes
// from carbon-runtime-contract rather than from the binary this used to be
// compiled into — the same move that let carbon-os become a crate.
//
// ── THE ABI IS FROZEN ───────────────────────────────────────────────────────
// `solutions/contracts/plugin/abi/carbon_abi.h` is the C header plugin authors
// build against, and plugins ship prebuilt. A layout change here does not break
// a build — it breaks plugins already installed on users' machines. That is the
// worst blast radius in the repository.

// ── Layout ──────────────────────────────────────────────────────────────────
//   abi/        the C-ABI surface a plugin receives. Frozen — plugins ship
//               prebuilt, so a layout change here breaks ones already
//               installed.
//   adapters/   finding, opening and registering a plugin: a driven adapter
//               over libloading, like every other adapter in this tier.
//               Replaceable; the ABI is not.
//   native/     the actual OS-capability implementations backing some ABI
//               trampolines (clipboard, dialog, notification, keychain) —
//               plain Rust functions host_exports.rs's trampolines call and
//               marshal across the C boundary. Colocated with the ABI that
//               exposes them, the same way carbon-text-renderer (a crate
//               dependency instead, being much larger) backs load_font_*.
//               Moved here from carbon-os, which used to install these as
//               always-on ambient globals rather than an opt-in plugin.
//
// Two directories rather than two loose files because the difference in blast
// radius between them is the most important thing about this crate. `abi/`
// keeps its own name rather than becoming a port: a port is an interface this
// crate calls outward through, and this is an interface OTHER people's
// prebuilt binaries were compiled against.
#[path = "abi/host_exports.rs"]
pub mod host_exports;
// Two mutually-exclusive implementations of the SAME module path, picked by
// the `static-plugins` Cargo feature — `carbon-mini`/`carbon-blitz`'s own
// code (composition/mini.rs, run_loop.rs) calls `plugin_loader::
// PluginRegistry` and never needs to know which one it got. Off (default):
// today's dlopen/dlsym/Ed25519 pipeline, what `carbon dev` and a standalone
// `carbon plugin build` always use. On: the statically-linked release
// counterpart — see plugin_loader_static.rs's header comment for why it can
// be so much shorter.
#[cfg(not(feature = "static-plugins"))]
#[path = "adapters/plugin_loader.rs"]
pub mod plugin_loader;
#[cfg(feature = "static-plugins")]
#[path = "adapters/plugin_loader_static.rs"]
pub mod plugin_loader;
#[path = "native/clipboard.rs"]
pub mod clipboard;
#[path = "native/dialog.rs"]
pub mod dialog;
#[path = "native/notification.rs"]
pub mod notification;
#[path = "native/keychain.rs"]
pub mod keychain;
#[path = "native/global_shortcuts.rs"]
pub mod global_shortcuts;
#[path = "native/tray.rs"]
pub mod tray;
#[path = "native/deeplink.rs"]
pub mod deeplink;
