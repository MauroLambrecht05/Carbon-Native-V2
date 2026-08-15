// pty — a pseudo-terminal session.
//
// The one binding with a push side: the runtime calls
// `__cm_pty_dispatch_output` / `__cm_pty_dispatch_exit` on globalThis, and the
// first PtySession constructed installs those dispatchers.

declare const __cm_pty_spawn: (cmd: string, optsJson: string) => number;
declare const __cm_pty_write: (id: number, data: string) => number;
declare const __cm_pty_resize: (id: number, cols: number, rows: number) => void;
declare const __cm_pty_read: (id: number) => string;
declare const __cm_pty_kill: (id: number) => void;
declare const __cm_pty_close: (id: number) => void;
declare const __cm_pty_wait: (id: number) => number;

export interface PtySpawnOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

/** A live PTY session. Reads come back as UTF-8 strings; writes go in
 *  as UTF-8 strings (or any byte sequence the JS string can carry). */
export class PtySession {
  /** Hooked by `onData` — called every time new output is available. */
  private dataListeners = new Set<(bytes: Uint8Array) => void>();
  private exitListeners = new Set<(code: number) => void>();
  private closed = false;

  constructor(public readonly id: number) {
    PtySession._register(this);
  }

  /** Subscribe to incoming bytes (raw, no decode). Returns an unsubscribe. */
  onData(cb: (bytes: Uint8Array) => void): () => void {
    this.dataListeners.add(cb);
    return () => { this.dataListeners.delete(cb); };
  }

  onExit(cb: (code: number) => void): () => void {
    this.exitListeners.add(cb);
    return () => { this.exitListeners.delete(cb); };
  }

  /** Write text to the PTY's master (the child sees it on stdin). */
  write(data: string): number { return __cm_pty_write(this.id, data); }

  resize(cols: number, rows: number): void { __cm_pty_resize(this.id, cols, rows); }

  /** Drain any buffered output as raw bytes. Polling alternative to
   *  `onData` — most apps will prefer the event listener. */
  read(): Uint8Array {
    const b64 = __cm_pty_read(this.id);
    if (!b64) return new Uint8Array(0);
    return base64ToBytes(b64);
  }

  /** Send SIGKILL / TerminateProcess. The session can still be read
   *  from to drain leftover output before close(). */
  kill(): void { __cm_pty_kill(this.id); }

  /** Hard-close: drop the session, cleanup resources. After this the
   *  id is invalid. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    PtySession._unregister(this);
    __cm_pty_close(this.id);
  }

  /** Block until the child exits, return its code. */
  wait(): number { return __cm_pty_wait(this.id); }

  private static sessions = new Map<number, PtySession>();
  private static dispatcherInstalled = false;

  private static _register(s: PtySession) {
    PtySession.sessions.set(s.id, s);
    if (!PtySession.dispatcherInstalled) {
      PtySession.dispatcherInstalled = true;
      (globalThis as any).__cm_pty_dispatch_output = (id: number) => {
        const sess = PtySession.sessions.get(id);
        if (!sess) return;
        const bytes = sess.read();
        if (bytes.length === 0) return;
        for (const cb of sess.dataListeners) {
          try { cb(bytes); } catch (_) {}
        }
      };
      (globalThis as any).__cm_pty_dispatch_exit = (id: number) => {
        const sess = PtySession.sessions.get(id);
        if (!sess) return;
        const code = sess.wait();
        for (const cb of sess.exitListeners) {
          try { cb(code); } catch (_) {}
        }
      };
    }
  }
  private static _unregister(s: PtySession) {
    PtySession.sessions.delete(s.id);
  }
}

export const pty = {
  spawn(cmd: string, opts: PtySpawnOptions = {}): PtySession {
    const id = __cm_pty_spawn(cmd, JSON.stringify(opts));
    return new PtySession(id);
  },
};

// Internal: base64 → Uint8Array. Mirrors the helper in net_shim.js but
// scoped to this module so we don't depend on its presence.
function base64ToBytes(b64: string): Uint8Array {
  const binStr = (globalThis as any).atob
    ? (globalThis as any).atob(b64)
    : decodeBase64Manually(b64);
  const out = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i);
  return out;
}

function decodeBase64Manually(b64: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lut = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) lut.set(alphabet[i], i);
  let bits = 0, value = 0;
  let out = "";
  for (const ch of b64) {
    if (ch === "=" || ch === "\n" || ch === "\r" || ch === " ") continue;
    const v = lut.get(ch);
    if (v === undefined) continue;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((value >> bits) & 0xff);
    }
  }
  return out;
}
