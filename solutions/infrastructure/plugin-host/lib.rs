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
//
// Two directories rather than two loose files because the difference in blast
// radius between them is the most important thing about this crate. `abi/`
// keeps its own name rather than becoming a port: a port is an interface this
// crate calls outward through, and this is an interface OTHER people's
// prebuilt binaries were compiled against.
#[path = "abi/host_exports.rs"]
pub mod host_exports;
#[path = "adapters/plugin_loader.rs"]
pub mod plugin_loader;
