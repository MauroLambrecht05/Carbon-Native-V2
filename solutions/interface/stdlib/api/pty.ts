// Pseudoterminal port. Backed by the `portable-pty` crate (Unix openpty
// / Windows ConPTY). One `spawn()` returns a handle id; subsequent
// reads/writes/resizes/close go through that id.
//
//   import { spawn } from "@carbon/api/pty";
//   const id = spawn({ shell: "pwsh.exe", cwd: "C:/", cols: 80, rows: 24 });
//   write(id, "echo hi\r");
//   const data = read(id); // drain output
//   close(id);
//
// For streaming output, hook the engine's __cm_pty_dispatch_output
// global directly — the @carbon/mini-react wrapper already wraps
// dispatcher callbacks in flushSync so setState inside the handler
// commits correctly. A higher-level `subscribeOutput(id, cb)` helper
// lives below.

import "./hosts";

export interface SpawnSpec {
  /** Command to run. "pwsh.exe" / "bash" / "/bin/zsh" etc. */
  shell: string;
  /** Working directory the child starts in. */
  cwd?: string;
  /** Initial terminal columns. */
  cols?: number;
  /** Initial terminal rows. */
  rows?: number;
  /** Extra env vars to overlay on the parent's environment. */
  env?: Record<string, string>;
  /** Extra args passed to the shell (e.g. ["-NoProfile"] for pwsh). */
  args?: string[];
}

/** Spawn a child process attached to a fresh PTY. Returns the handle id
 *  used for every subsequent op. Throws if the shell binary isn't
 *  resolvable. */
export function spawn(spec: SpawnSpec): number {
  return __cm_pty_spawn(JSON.stringify(spec));
}

/** Write bytes to the PTY's stdin (the child reads them). UTF-8 string;
 *  use `\r` for Enter in shell input (Windows pwsh + Unix shells both
 *  accept it). */
export function write(id: number, data: string): void {
  __cm_pty_write(id, data);
}

/** Drain any pending output from the PTY. Returns "" when there's
 *  nothing buffered. For continuous streaming, prefer
 *  `subscribeOutput(id, cb)`. */
export function read(id: number): string {
  return __cm_pty_read(id);
}

/** Tell the child the terminal has resized. Sends SIGWINCH on unix /
 *  ResizePseudoConsole on Windows. */
export function resize(id: number, cols: number, rows: number): void {
  __cm_pty_resize(id, cols, rows);
}

/** Close the PTY (the child receives EOF on its stdin and SIGHUP). */
export function close(id: number): void {
  __cm_pty_close(id);
}

/** Send SIGKILL / TerminateProcess. Use sparingly — `close()` is
 *  cleaner unless the child is hung. */
export function kill(id: number): void {
  __cm_pty_kill(id);
}

/** Block until the child exits and return its exit code. */
export async function wait(id: number): Promise<number> {
  return __cm_pty_wait(id);
}

// ─── Output subscription ────────────────────────────────────────────────
//
// The engine fires `__cm_pty_dispatch_output(id)` whenever a child
// produces stdout. We chain off the existing dispatcher (so multiple
// subscribers coexist) and route each id to the right callback set.

type OutputCb = (chunk: string) => void;
const outputSubscribers = new Map<number, Set<OutputCb>>();

(() => {
  const g = globalThis as unknown as {
    __cm_pty_dispatch_output?: (id: number) => void;
  };
  const prev = g.__cm_pty_dispatch_output;
  g.__cm_pty_dispatch_output = (id: number) => {
    try { prev?.(id); } catch { /* keep going */ }
    const subs = outputSubscribers.get(id);
    if (!subs || subs.size === 0) return;
    let chunk: string;
    try { chunk = __cm_pty_read(id); } catch { return; }
    if (!chunk) return;
    for (const cb of Array.from(subs)) {
      try { cb(chunk); } catch (e) { console.error("[pty.subscribeOutput]", e); }
    }
  };
})();

/** Subscribe to PTY output. Each callback fires once per dispatcher
 *  tick with whatever stdout the child has produced since the last
 *  read. Returns an unsubscribe function. */
export function subscribeOutput(id: number, cb: OutputCb): () => void {
  let set = outputSubscribers.get(id);
  if (!set) {
    set = new Set();
    outputSubscribers.set(id, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) outputSubscribers.delete(id);
  };
}
