// The Rust side of contracts/app.
//
// carbon.toml is already declared here twice — `schema/carbon.schema.json` for
// editors and validators, and `types/CarbonManifest.ts` for the toolchain. This
// is the third rendering, for the runtime that actually reads the file at
// startup. All three describe one agreement, which is why they live together:
// a field added to one and not the others is a manifest the toolchain accepts
// and the runtime ignores, or the reverse.
//
// It carries more than the manifest, because V1's shared/logic/core did:
//
//   config   the carbon.toml schema — [app], [runtime], [window],
//            [capabilities], [plugins]
//   ipc      the message shapes crossing the JS <-> host channel
//   shell    capability-checked shell command matching
//
// ipc and shell are here rather than in infrastructure because they are
// agreements too: `ipc` is the envelope both sides serialise, and `shell`
// decides whether a command matches what carbon.toml permitted. Neither has an
// implementation to swap.

// carbon-core — shared invariants across every carbon backend.
//
// What lives here is exactly what every carbon runtime that uses rquickjs +
// carbon.toml + the standard IPC envelope needs:
//   - `config`  carbon.toml manifest schema + parser
//   - `ipc`     wire envelope: { id, fn, args } / { id, ok | error }
//   - `shell`   rquickjs Shell + capability-bound host imports
//
// What does NOT live here:
//   - The window + renderer integration (wry, versoview, tao+skia) — backend-specific.
//   - The file watcher transport — webview2 uses tao::EventLoopProxy, verso
//     uses crossbeam_channel; that divergence is by design.
//   - The IPC handler itself — each backend wires the wire envelope into
//     its own webview's postMessage / fetch / etc.
//
// Backends opt into core piecemeal. carbon-mini doesn't currently use any of
// these because it has no IPC envelope (JS calls Rust functions in-process)
// and no carbon.toml today; it'll wire in when those features land.

pub mod config;
pub mod ipc;
pub mod shell;
