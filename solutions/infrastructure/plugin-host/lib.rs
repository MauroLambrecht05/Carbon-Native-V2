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
//   abi/             the C-ABI surface a plugin receives. Frozen — plugins
//                    ship prebuilt, so a layout change here breaks ones
//                    already installed.
//   adapters/        finding, opening and registering a plugin: driven
//                    adapters over libloading (plugin_loader) and the OS
//                    (native/), like every other adapter in this tier.
//                    Replaceable; the ABI is not.
//   adapters/native/ the actual OS-capability implementations backing some
//                    ABI trampolines (clipboard, dialog, notification,
//                    keychain) — plain Rust functions host_exports.rs's
//                    trampolines call and marshal across the C boundary.
//                    Nested under adapters/ (an infrastructure/ package is
//                    made of ports + adapters + abi + tests, nothing else —
//                    "native" isn't its own vocabulary word) rather than a
//                    sibling of it, the same way carbon-text-renderer (a
//                    crate dependency instead, being much larger) backs
//                    load_font_*. Moved here from carbon-os, which used to
//                    install these as always-on ambient globals rather than
//                    an opt-in plugin.
//
// `abi/` keeps its own name rather than becoming a port: a port is an
// interface this crate calls outward through, and this is an interface OTHER
// people's prebuilt binaries were compiled against.
#[path = "abi/host_exports.rs"]
pub mod host_exports;

// Two mutually-exclusive implementations of the SAME module path, picked by
// the `static-plugins` Cargo feature — `carbon-mini`/`carbon-blitz`'s own
// code (composition/mini.rs, run_loop.rs) calls `plugin_loader::
// PluginRegistry` and never needs to know which one it got. Off (default):
// today's dlopen/dlsym/Ed25519 pipeline, what `carbon dev` and a standalone
// `carbon plugin build` always use. On: the statically-linked release
// counterpart — see plugin_loader_static.rs's header comment for why it can
// be so much shorter. Kept as its own blank-line-separated group so
// rustfmt's alphabetical mod reordering can't drift this comment onto an
// unrelated item below.
#[cfg(not(feature = "static-plugins"))]
#[path = "adapters/plugin_loader.rs"]
pub mod plugin_loader;
#[cfg(feature = "static-plugins")]
#[path = "adapters/plugin_loader_static.rs"]
pub mod plugin_loader;

#[cfg(feature = "accessibility")]
#[path = "adapters/native/accessibility.rs"]
pub mod accessibility;
#[cfg(feature = "biometrics")]
#[path = "adapters/native/biometrics.rs"]
pub mod biometrics;
#[cfg(feature = "camera")]
#[path = "adapters/native/camera.rs"]
pub mod camera;
// Carbon self-introspection (ABI 1.23) — always-on, like push_event/eval
// above: no external dependency to opt out of, and manifest_read needs
// carbon-core, which is already a mandatory (non-optional) dependency of
// this crate.
#[path = "adapters/native/carbon_manifest.rs"]
pub mod carbon_manifest;
#[path = "adapters/native/framecache.rs"]
pub mod framecache;
#[cfg(feature = "bluetooth")]
#[path = "adapters/native/bluetooth.rs"]
pub mod bluetooth;
#[cfg(feature = "clipboard")]
#[path = "adapters/native/clipboard.rs"]
pub mod clipboard;
#[cfg(feature = "deeplink")]
#[path = "adapters/native/deeplink.rs"]
pub mod deeplink;
#[cfg(feature = "dialog")]
#[path = "adapters/native/dialog.rs"]
pub mod dialog;
#[cfg(feature = "shortcuts")]
#[path = "adapters/native/global_shortcuts.rs"]
pub mod global_shortcuts;
#[cfg(feature = "input")]
#[path = "adapters/native/input.rs"]
pub mod input;
#[cfg(feature = "instance")]
#[path = "adapters/native/instance.rs"]
pub mod instance;
#[cfg(feature = "keychain")]
#[path = "adapters/native/keychain.rs"]
pub mod keychain;
#[cfg(feature = "logging")]
#[path = "adapters/native/logging.rs"]
pub mod logging;
#[cfg(feature = "media")]
#[path = "adapters/native/media.rs"]
pub mod media;
#[cfg(feature = "microphone")]
#[path = "adapters/native/microphone.rs"]
pub mod microphone;
#[cfg(feature = "menu")]
#[path = "adapters/native/menu.rs"]
pub mod menu;
// Shared MenuEvent-channel dispatcher for tray.rs and menu.rs — see its own
// header comment for why this can't just live inside either one.
#[cfg(any(feature = "tray", feature = "menu"))]
#[path = "adapters/native/menu_events.rs"]
pub mod menu_events;
#[cfg(feature = "notify")]
#[path = "adapters/native/notification.rs"]
pub mod notification;
#[cfg(feature = "printing")]
#[path = "adapters/native/printing.rs"]
pub mod printing;
#[cfg(feature = "screencapture")]
#[path = "adapters/native/screencapture.rs"]
pub mod screencapture;
#[cfg(feature = "sharing")]
#[path = "adapters/native/sharing.rs"]
pub mod sharing;
#[cfg(feature = "sqlite")]
#[path = "adapters/native/sqlite.rs"]
pub mod sqlite;
#[cfg(feature = "taskbar")]
#[path = "adapters/native/taskbar.rs"]
pub mod taskbar;
#[cfg(feature = "theme")]
#[path = "adapters/native/theme.rs"]
pub mod theme;
#[cfg(feature = "tray")]
#[path = "adapters/native/tray.rs"]
pub mod tray;
