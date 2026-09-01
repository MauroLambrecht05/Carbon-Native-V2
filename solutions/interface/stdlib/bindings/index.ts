// TypeScript wrappers over the native host imports registered by
// infrastructure/os. Apps import what they need:
//
//   import { fs, process, shell, autostart, windowState } from "@carbon/runtime-bindings";
//
// Each export is a small namespace whose methods call into the
// `__cm_*` globals injected by the Rust runtime. Errors thrown by the
// Rust side propagate as JS Errors; explicit "missing" cases (no
// saved window state) return null rather than throw.
//
// dialog/clipboard/notification/keychain moved OUT of this always-on
// surface and into opt-in carbon-sdk plugins — see
// `@carbon/plugins/{dialog,clipboard,notification,keychain}` instead. This
// was a deliberate breaking change: those four don't mediate a permission
// boundary the way fs/net do, so they follow fonts' plugin pattern (`carbon
// plugin add <name>`, then `import { useX } from "@carbon/plugins/<name>"`)
// instead of being ambient globals every app carries whether it uses them
// or not.
//
// Synchronous on purpose — every method blocks on the OS call.
// Long-running interactions (a spawned child process, a streamed
// download) use the handle pattern: spawn() returns an id, then
// separate read/write/wait/kill ops drain it.
//
// ── LAYOUT ──────────────────────────────────────────────────────────────────
// The directories are the same eight areas `infrastructure/os` groups its
// host functions into — bridge, desktop, filesystem, net, process, storage,
// system, window — because that is the same boundary seen from the other
// side. A host function and its wrapper are then always in same-named
// directories on both sides of the JS↔Rust line, and "where does a new
// binding go" has the answer "wherever its host function went".
//
// Each module declares only the `__cm_*` functions it calls, next to the
// wrapper that calls them, rather than the tree of ambient declarations this
// file used to open with.
//
// ── WHY THIS EXISTS ALONGSIDE @carbon/api ───────────────────────────────────
// They are not duplicates. This covers 37 host functions @carbon/api does not:
// clipboard, dialog, keychain, notification, process, store and window-state.
// @carbon/api covers subpaths this does not. Between them they reach 111 of the
// 139 functions in contracts/runtime.
//
// The overlap and the gap are both accidents of V1, where the two packages grew
// separately. Reconciling them — one surface, generated from the registry — is
// worth doing and has not been done. Neither is dropped in the meantime.

export { fs } from "./filesystem/fs.ts";
export type { FileStat } from "./filesystem/fs.ts";

export { process, ChildProcess } from "./process/process.ts";
export type { ExecResult, SpawnOptions } from "./process/process.ts";
// PTY moved to the terminal plugin (carbon:terminal) — not always-on
// anymore, see products/carbon-sdk/terminal.
export { shell } from "./process/shell.ts";

export { Store } from "./storage/store.ts";

export { autostart } from "./system/autostart.ts";
export { os } from "./system/os.ts";
export { log } from "./system/log.ts";
export type { LogLevel } from "./system/log.ts";

export { windowState } from "./window/window-state.ts";

export { net } from "./net/net.ts";

export { invoke, registerInvoke, hasCommand } from "./bridge/invoke.ts";
export { Channel, getChannel } from "./bridge/channel.ts";
