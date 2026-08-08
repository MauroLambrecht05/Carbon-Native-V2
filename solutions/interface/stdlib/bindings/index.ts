// TypeScript wrappers over the native host imports registered by
// infrastructure/os. Apps import what they need:
//
//   import { fs, process, dialog, shell, clipboard, notification,
//            autostart, windowState, keychain } from "@carbon/runtime-bindings";
//
// Each export is a small namespace whose methods call into the
// `__cm_*` globals injected by the Rust runtime. Errors thrown by the
// Rust side propagate as JS Errors; explicit "missing" cases (no
// keychain entry, no saved window state) return null rather than throw.
//
// Synchronous on purpose — every method blocks on the OS call.
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
// Long-running interactions (a spawned child process, a streamed
// download) use the handle pattern: spawn() returns an id, then
// separate read/write/wait/kill ops drain it.

// ─── Ambient declarations for the host imports ────────────────────────────
declare const __cm_fs_read_text: (path: string) => string;
declare const __cm_fs_write_text: (path: string, content: string) => void;
declare const __cm_fs_exists: (path: string) => boolean;
declare const __cm_fs_is_file: (path: string) => boolean;
declare const __cm_fs_is_dir: (path: string) => boolean;
declare const __cm_fs_read_dir: (path: string) => string[];
declare const __cm_fs_mkdir: (path: string, recursive: boolean) => void;
declare const __cm_fs_rm: (path: string, recursive: boolean) => void;
declare const __cm_fs_rename: (from: string, to: string) => void;
declare const __cm_fs_stat: (path: string) => string;
declare const __cm_fs_home_dir: () => string | null;
declare const __cm_fs_app_data_dir: () => string | null;
declare const __cm_fs_app_config_dir: () => string | null;
declare const __cm_fs_app_cache_dir: () => string | null;
declare const __cm_fs_temp_dir: () => string;

declare const __cm_proc_exec: (cmd: string, argsJson: string, cwd: string) => string;
declare const __cm_proc_spawn: (cmd: string, argsJson: string, cwd: string) => number;
declare const __cm_proc_write_stdin: (id: number, data: string) => number;
declare const __cm_proc_read_stdout: (id: number) => string;
declare const __cm_proc_read_stderr: (id: number) => string;
declare const __cm_proc_kill: (id: number) => void;
declare const __cm_proc_wait: (id: number) => number;
declare const __cm_proc_try_status: (id: number) => number;
declare const __cm_proc_pid_self: () => number;

declare const __cm_dialog_open_file: (optsJson: string) => string | null;
declare const __cm_dialog_open_files: (optsJson: string) => string[];
declare const __cm_dialog_open_dir: (optsJson: string) => string | null;
declare const __cm_dialog_save_file: (optsJson: string) => string | null;
declare const __cm_dialog_message: (title: string, body: string, level: string) => void;
declare const __cm_dialog_confirm: (title: string, body: string) => boolean;

declare const __cm_shell_open: (target: string) => void;
declare const __cm_shell_reveal: (path: string) => void;
declare const __cm_shell_resolve: (path: string) => string | null;

declare const __cm_clipboard_read_text: () => string;
declare const __cm_clipboard_write_text: (text: string) => void;
declare const __cm_clipboard_clear: () => void;

declare const __cm_notification_send: (title: string, body: string, icon: string) => void;

declare const __cm_autostart_set_name: (name: string) => void;
declare const __cm_autostart_set_args: (argsJson: string) => void;
declare const __cm_autostart_enable: () => void;
declare const __cm_autostart_disable: () => void;
declare const __cm_autostart_is_enabled: () => boolean;

declare const __cm_window_state_set_app_name: (name: string) => void;
declare const __cm_window_state_save: (json: string) => void;
declare const __cm_window_state_load: () => string | null;
declare const __cm_window_state_clear: () => void;

declare const __cm_keychain_set: (service: string, account: string, password: string) => void;
declare const __cm_keychain_get: (service: string, account: string) => string | null;
declare const __cm_keychain_delete: (service: string, account: string) => void;

// ─── fs ───────────────────────────────────────────────────────────────────

export interface FileStat {
  size: number;
  modifiedMs: number;
  isFile: boolean;
  isDir: boolean;
}

export const fs = {
  readText: (path: string): string => __cm_fs_read_text(path),
  writeText: (path: string, content: string): void => __cm_fs_write_text(path, content),
  exists: (path: string): boolean => __cm_fs_exists(path),
  isFile: (path: string): boolean => __cm_fs_is_file(path),
  isDir: (path: string): boolean => __cm_fs_is_dir(path),
  readDir: (path: string): string[] => __cm_fs_read_dir(path),
  mkdir: (path: string, recursive = true): void => __cm_fs_mkdir(path, recursive),
  rm: (path: string, recursive = false): void => __cm_fs_rm(path, recursive),
  rename: (from: string, to: string): void => __cm_fs_rename(from, to),
  stat: (path: string): FileStat => JSON.parse(__cm_fs_stat(path)),
  homeDir: (): string | null => __cm_fs_home_dir(),
  appDataDir: (): string | null => __cm_fs_app_data_dir(),
  appConfigDir: (): string | null => __cm_fs_app_config_dir(),
  appCacheDir: (): string | null => __cm_fs_app_cache_dir(),
  tempDir: (): string => __cm_fs_temp_dir(),
};

// ─── process ──────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SpawnOptions {
  cwd?: string;
}

export class ChildProcess {
  constructor(public readonly id: number) {}

  writeStdin(data: string): number {
    return __cm_proc_write_stdin(this.id, data);
  }
  readStdout(): string { return __cm_proc_read_stdout(this.id); }
  readStderr(): string { return __cm_proc_read_stderr(this.id); }
  /** Returns null while the child is still running; the exit code on completion. */
  tryStatus(): number | null {
    const s = __cm_proc_try_status(this.id);
    return s === -2 ? null : s;
  }
  kill(): void { __cm_proc_kill(this.id); }
  /** Blocks until the child exits and returns its exit code. */
  wait(): number { return __cm_proc_wait(this.id); }
}

export const process = {
  /** Runs `cmd args...` and blocks until it exits. */
  exec: (cmd: string, args: string[] = [], opts: SpawnOptions = {}): ExecResult => {
    return JSON.parse(__cm_proc_exec(cmd, JSON.stringify(args), opts.cwd ?? "")) as ExecResult;
  },
  /** Spawns `cmd args...` with piped stdio; returns a handle for streaming I/O. */
  spawn: (cmd: string, args: string[] = [], opts: SpawnOptions = {}): ChildProcess => {
    return new ChildProcess(__cm_proc_spawn(cmd, JSON.stringify(args), opts.cwd ?? ""));
  },
  pidSelf: (): number => __cm_proc_pid_self(),
};

// ─── dialog ───────────────────────────────────────────────────────────────

export interface FileFilter {
  name: string;
  extensions: string[];
}
export interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
}

export const dialog = {
  openFile: (opts: OpenDialogOptions = {}): string | null =>
    __cm_dialog_open_file(JSON.stringify(opts)),
  openFiles: (opts: OpenDialogOptions = {}): string[] =>
    __cm_dialog_open_files(JSON.stringify(opts)),
  openDir: (opts: OpenDialogOptions = {}): string | null =>
    __cm_dialog_open_dir(JSON.stringify(opts)),
  saveFile: (opts: OpenDialogOptions = {}): string | null =>
    __cm_dialog_save_file(JSON.stringify(opts)),
  message: (title: string, body: string, level: "info" | "warning" | "error" = "info"): void =>
    __cm_dialog_message(title, body, level),
  confirm: (title: string, body: string): boolean => __cm_dialog_confirm(title, body),
};

// ─── shell ────────────────────────────────────────────────────────────────

export const shell = {
  /** Opens URL or file path in the OS-default handler. */
  open: (target: string): void => __cm_shell_open(target),
  /** Highlights the file in the OS file manager (Explorer / Finder / nautilus). */
  reveal: (path: string): void => __cm_shell_reveal(path),
  /** Canonicalize a path. Returns null if it can't resolve. */
  resolve: (path: string): string | null => __cm_shell_resolve(path),
};

// ─── clipboard ────────────────────────────────────────────────────────────

export const clipboard = {
  readText: (): string => __cm_clipboard_read_text(),
  writeText: (text: string): void => __cm_clipboard_write_text(text),
  clear: (): void => __cm_clipboard_clear(),
};

// ─── notification ─────────────────────────────────────────────────────────

export interface NotificationOptions {
  title: string;
  body: string;
  /** Path to an icon file on disk. Optional. */
  icon?: string;
}

export const notification = {
  send: (opts: NotificationOptions): void =>
    __cm_notification_send(opts.title, opts.body, opts.icon ?? ""),
};

// ─── autostart ────────────────────────────────────────────────────────────

export const autostart = {
  /** Override the autostart entry name (defaults to the binary's file stem). */
  setName: (name: string): void => __cm_autostart_set_name(name),
  setArgs: (args: string[]): void => __cm_autostart_set_args(JSON.stringify(args)),
  enable: (): void => __cm_autostart_enable(),
  disable: (): void => __cm_autostart_disable(),
  isEnabled: (): boolean => __cm_autostart_is_enabled(),
};

// ─── window state ─────────────────────────────────────────────────────────

export const windowState = {
  /** Override the app name used to scope the state file (defaults to exe stem). */
  setAppName: (name: string): void => __cm_window_state_set_app_name(name),
  /** Save arbitrary JSON-serializable state. Persists in the OS config dir. */
  save: (state: unknown): void => __cm_window_state_save(JSON.stringify(state)),
  /** Returns the saved state, or null if nothing has been persisted yet. */
  load: <T = unknown>(): T | null => {
    const raw = __cm_window_state_load();
    if (raw == null) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },
  clear: (): void => __cm_window_state_clear(),
};

// ─── net: fetch / WebSocket / Headers / AbortController ───────────────────
//
// The Rust runtime installs Web-compatible `fetch`, `Response`, `Headers`,
// `AbortController`, `AbortSignal`, and `WebSocket` on `globalThis` at
// startup (see `carbon/host/native/net_shim.js`). They follow the
// WHATWG / W3C contracts close enough that most ported web code Just
// Works:
//
//   const r = await fetch("https://api.example.com/x", { method: "POST",
//     headers: { "content-type": "application/json" },
//     body: JSON.stringify({ hi: "world" }) });
//   const data = await r.json();
//
//   const ws = new WebSocket("wss://example.com/socket");
//   ws.onmessage = (e) => console.log(e.data);
//   ws.send("ping");
//
// Streaming bodies (SSE for LLM clients, chunked downloads):
//
//   const r = await fetch(url);
//   const reader = r.body.getReader();
//   while (true) {
//     const { done, value } = await reader.read();
//     if (done) break;
//     // value is a Uint8Array
//   }
//
// Cancellation:
//
//   const ctl = new AbortController();
//   fetch(url, { signal: ctl.signal });
//   ctl.abort();
//
// The ambient declarations below give your app the types without needing
// `"DOM"` in tsconfig `lib`. They mirror the subset of the spec we
// implement; FormData / Blob / URLSearchParams body types and CORS modes
// are not (yet) supported — string / Uint8Array / ArrayBuffer bodies are.

declare global {
  // Headers
  interface CarbonHeaders {
    append(name: string, value: string): void;
    delete(name: string): void;
    get(name: string): string | null;
    has(name: string): boolean;
    set(name: string, value: string): void;
    forEach(cb: (value: string, key: string, parent: CarbonHeaders) => void, thisArg?: unknown): void;
    entries(): IterableIterator<[string, string]>;
    keys(): IterableIterator<string>;
    values(): IterableIterator<string>;
    [Symbol.iterator](): IterableIterator<[string, string]>;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const Headers: { new (init?: Record<string, string> | [string, string][] | CarbonHeaders): CarbonHeaders };

  // AbortController / AbortSignal
  interface CarbonAbortSignal {
    readonly aborted: boolean;
    readonly reason: unknown;
    onabort: ((ev: { type: "abort"; target: CarbonAbortSignal }) => void) | null;
    addEventListener(type: "abort", cb: (ev: { type: "abort"; target: CarbonAbortSignal }) => void): void;
    removeEventListener(type: "abort", cb: (ev: { type: "abort"; target: CarbonAbortSignal }) => void): void;
    throwIfAborted(): void;
  }
  interface CarbonAbortController {
    readonly signal: CarbonAbortSignal;
    abort(reason?: unknown): void;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const AbortController: { new (): CarbonAbortController };
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const AbortSignal: { new (): CarbonAbortSignal };

  // Response
  interface CarbonResponseBody {
    getReader(): {
      read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
      cancel(): Promise<void>;
      releaseLock(): void;
    };
  }
  interface CarbonResponse {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly headers: CarbonHeaders;
    readonly url: string;
    readonly type: "basic";
    readonly redirected: boolean;
    readonly bodyUsed: boolean;
    readonly body: CarbonResponseBody;
    text(): Promise<string>;
    json<T = unknown>(): Promise<T>;
    arrayBuffer(): Promise<ArrayBuffer>;
    bytes(): Promise<Uint8Array>;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const Response: { new (...args: unknown[]): CarbonResponse };

  interface CarbonRequestInit {
    method?: string;
    headers?: CarbonHeaders | Record<string, string> | [string, string][];
    body?: string | Uint8Array | ArrayBuffer | ArrayBufferView | null;
    signal?: CarbonAbortSignal;
  }
  function fetch(input: string | { url: string }, init?: CarbonRequestInit): Promise<CarbonResponse>;

  // WebSocket
  interface CarbonWebSocketEvent { type: string; target: CarbonWebSocket }
  interface CarbonWebSocketMessageEvent extends CarbonWebSocketEvent {
    type: "message";
    data: string | ArrayBuffer | Uint8Array;
  }
  interface CarbonWebSocketCloseEvent extends CarbonWebSocketEvent {
    type: "close";
    code: number;
    reason: string;
    wasClean: boolean;
  }
  interface CarbonWebSocketErrorEvent extends CarbonWebSocketEvent {
    type: "error";
    message: string;
  }
  interface CarbonWebSocket {
    readonly url: string;
    readonly readyState: number; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    readonly bufferedAmount: number;
    binaryType: "arraybuffer" | "uint8array";
    onopen: ((ev: CarbonWebSocketEvent) => void) | null;
    onmessage: ((ev: CarbonWebSocketMessageEvent) => void) | null;
    onclose: ((ev: CarbonWebSocketCloseEvent) => void) | null;
    onerror: ((ev: CarbonWebSocketErrorEvent) => void) | null;
    addEventListener(type: "open", cb: (ev: CarbonWebSocketEvent) => void): void;
    addEventListener(type: "message", cb: (ev: CarbonWebSocketMessageEvent) => void): void;
    addEventListener(type: "close", cb: (ev: CarbonWebSocketCloseEvent) => void): void;
    addEventListener(type: "error", cb: (ev: CarbonWebSocketErrorEvent) => void): void;
    removeEventListener(type: string, cb: (...args: unknown[]) => void): void;
    send(data: string | Uint8Array | ArrayBuffer | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
  }
  // eslint-disable-next-line @typescript-eslint/no-redeclare
  const WebSocket: {
    new (url: string, protocols?: string | string[]): CarbonWebSocket;
    readonly CONNECTING: 0;
    readonly OPEN: 1;
    readonly CLOSING: 2;
    readonly CLOSED: 3;
  };
}

// Optional named re-exports for IDE auto-import. These point at the
// runtime globals so you can write `import { fetch, WebSocket } from
// "@carbon/runtime-bindings"` if you prefer.
export const net = {
  // Cast through `unknown`. These four names are DECLARED in this file — the
  // runtime installs them via net_shim.js — so `typeof AbortController` here
  // means our declaration, and globalThis (lib ES2022, no DOM, no bun types)
  // has no member of that name to overlap with. Type-level only; the values
  // are whatever the runtime installed.
  fetch: (input: string | { url: string }, init?: CarbonRequestInit) =>
    (globalThis as unknown as { fetch: typeof fetch }).fetch(input, init),
  WebSocket: (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket,
  Headers: (globalThis as unknown as { Headers: typeof Headers }).Headers,
  AbortController: (globalThis as unknown as { AbortController: typeof AbortController })
    .AbortController,
};

// ─── keychain ─────────────────────────────────────────────────────────────

export const keychain = {
  /** Store a credential keyed by (service, account). */
  set: (service: string, account: string, password: string): void =>
    __cm_keychain_set(service, account, password),
  /** Returns null when no entry exists for (service, account). */
  get: (service: string, account: string): string | null =>
    __cm_keychain_get(service, account),
  /** Idempotent — deleting a missing entry is a no-op, not an error. */
  delete: (service: string, account: string): void =>
    __cm_keychain_delete(service, account),
};

// ─── pty ──────────────────────────────────────────────────────────────────

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

// ─── store ────────────────────────────────────────────────────────────────

declare const __cm_store_get: (file: string, key: string) => string;
declare const __cm_store_set: (file: string, key: string, valueJson: string) => void;
declare const __cm_store_delete: (file: string, key: string) => boolean;
declare const __cm_store_has: (file: string, key: string) => boolean;
declare const __cm_store_keys: (file: string) => string;
declare const __cm_store_entries: (file: string) => string;
declare const __cm_store_clear: (file: string) => void;
declare const __cm_store_save: (file: string) => void;
declare const __cm_store_reload: (file: string) => void;

/** Persistent KV store backed by a JSON file in the app config dir.
 *  Construct one per logical store (file name) — same pattern as
 *  `tauri-plugin-store`. */
export class Store {
  constructor(public readonly file: string) {}

  get<T = unknown>(key: string): T | null {
    const v = __cm_store_get(this.file, key);
    return JSON.parse(v) as T | null;
  }
  set(key: string, value: unknown): void {
    __cm_store_set(this.file, key, JSON.stringify(value));
  }
  delete(key: string): boolean { return __cm_store_delete(this.file, key); }
  has(key: string): boolean { return __cm_store_has(this.file, key); }
  keys(): string[] { return JSON.parse(__cm_store_keys(this.file)); }
  entries<T = unknown>(): Record<string, T> {
    return JSON.parse(__cm_store_entries(this.file));
  }
  clear(): void { __cm_store_clear(this.file); }
  save(): void { __cm_store_save(this.file); }
  reload(): void { __cm_store_reload(this.file); }
}

// ─── os ───────────────────────────────────────────────────────────────────

declare const __cm_os_platform: () => string;
declare const __cm_os_arch: () => string;
declare const __cm_os_version: () => string;
declare const __cm_os_hostname: () => string;
declare const __cm_os_temp_dir: () => string;
declare const __cm_os_home_dir: () => string;
declare const __cm_os_locale: () => string;
declare const __cm_os_eol: () => string;
declare const __cm_os_exe_path: () => string;
declare const __cm_os_family: () => string;

export const os = {
  /** "windows" | "macos" | "linux" | "android" | "ios" | "unknown". */
  platform: (): string => __cm_os_platform(),
  /** "x86_64" | "aarch64" | "x86" | "arm" | "unknown". */
  arch: (): string => __cm_os_arch(),
  /** A coarse identifier; apps that need exact kernel version should
   *  shell out via process.exec. */
  version: (): string => __cm_os_version(),
  hostname: (): string => __cm_os_hostname(),
  tempDir: (): string => __cm_os_temp_dir(),
  homeDir: (): string => __cm_os_home_dir(),
  locale: (): string => __cm_os_locale(),
  /** "\r\n" on Windows, "\n" elsewhere. */
  eol: (): string => __cm_os_eol(),
  exePath: (): string => __cm_os_exe_path(),
  /** "windows" | "unix" | "unknown". */
  family: (): string => __cm_os_family(),
};

// ─── log ──────────────────────────────────────────────────────────────────

declare const __cm_log: (level: string, target: string, message: string) => void;
declare const __cm_log_path: () => string;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

function fmtLogArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(" ");
}

export const log = {
  trace: (...args: unknown[]) => __cm_log("trace", "app", fmtLogArgs(args)),
  debug: (...args: unknown[]) => __cm_log("debug", "app", fmtLogArgs(args)),
  info:  (...args: unknown[]) => __cm_log("info",  "app", fmtLogArgs(args)),
  warn:  (...args: unknown[]) => __cm_log("warn",  "app", fmtLogArgs(args)),
  error: (...args: unknown[]) => __cm_log("error", "app", fmtLogArgs(args)),
  /** Targeted variant — second message gets routed under a named
   *  category so log filters can split UI logs from network logs etc. */
  with: (target: string) => ({
    trace: (...args: unknown[]) => __cm_log("trace", target, fmtLogArgs(args)),
    debug: (...args: unknown[]) => __cm_log("debug", target, fmtLogArgs(args)),
    info:  (...args: unknown[]) => __cm_log("info",  target, fmtLogArgs(args)),
    warn:  (...args: unknown[]) => __cm_log("warn",  target, fmtLogArgs(args)),
    error: (...args: unknown[]) => __cm_log("error", target, fmtLogArgs(args)),
  }),
  /** Path to the rolling log file. Useful for "open log folder" UI. */
  path: (): string => __cm_log_path(),
};

// ─── invoke ───────────────────────────────────────────────────────────────

declare const __cm_invoke: (name: string, argsJson: string) => string;
declare const __cm_invoke_has: (name: string) => boolean;

// JS-side invoke handler registry. Apps that port from a different
// host (Tauri, Electron, etc.) can wire their command names here
// without editing every call site:
//
//   registerInvoke('fs_read_file', async (args) => native.readFile(args.path));
//
// invoke() checks JS handlers FIRST, then falls back to the Rust
// runtime's __cm_invoke (which holds built-ins like 'window:*' and
// 'app:*'). Both paths share the same Promise-typed return so apps
// don't have to know which side handled their call.
type InvokeHandler = (args: Record<string, unknown>) => unknown;
const jsInvokeHandlers = new Map<string, InvokeHandler>();

export function registerInvoke(name: string, handler: InvokeHandler): void {
  jsInvokeHandlers.set(name, handler);
}

/** Call a registered command. Mirrors Tauri's `invoke()` — accepts an
 *  arbitrary args object and returns a Promise resolving to the result.
 *  Commands are synchronous on the Rust side; the Promise wrapper is
 *  here for API parity so existing Tauri code ports cleanly. */
export function invoke<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const jsHandler = jsInvokeHandlers.get(name);
  if (jsHandler) {
    try {
      const result = jsHandler(args ?? {});
      return Promise.resolve(result as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  try {
    const result = __cm_invoke(name, JSON.stringify(args));
    return Promise.resolve(JSON.parse(result) as T);
  } catch (e) {
    return Promise.reject(e);
  }
}

/** True when a command with this name has a handler registered. */
export function hasCommand(name: string): boolean {
  return __cm_invoke_has(name);
}

// ─── Channel ──────────────────────────────────────────────────────────────
//
// A small event-source object whose `onmessage` setter receives events
// pushed by host code. The shape matches Tauri's `Channel<T>` so apps
// porting from Tauri don't have to refactor every callback wiring —
// they just route their emit calls through the carbon-side dispatcher
// that owns the channel id.
//
// Implementation: each Channel has a numeric id (autoincrement). Apps
// register the channel with whatever host subsystem will push to it
// (PTY, fetch stream, etc.) by passing channel.id. The dispatcher
// looks up the channel via a module-scoped Map and calls .emit().

const channelRegistry = new Map<number, Channel<unknown>>();
let nextChannelId = 1;

export class Channel<T = unknown> {
  readonly id: number;
  private listener: ((event: T) => void) | null = null;
  private buffered: T[] = [];

  constructor() {
    this.id = nextChannelId++;
    channelRegistry.set(this.id, this as Channel<unknown>);
  }

  /** Tauri-shaped setter — assigning replaces the handler. Buffered
   *  events emitted before assignment fire immediately. */
  set onmessage(cb: (event: T) => void) {
    this.listener = cb;
    if (this.buffered.length) {
      const drained = this.buffered;
      this.buffered = [];
      for (const e of drained) {
        try { cb(e); } catch (_) {}
      }
    }
  }

  get onmessage(): ((event: T) => void) | null {
    return this.listener;
  }

  /** Push an event into the channel. Called by host dispatchers (or
   *  any JS code that has the channel reference). */
  emit(event: T): void {
    if (this.listener) {
      try { this.listener(event); } catch (_) {}
    } else {
      this.buffered.push(event);
    }
  }

  /** Drop the channel from the global registry. Idempotent. */
  close(): void {
    channelRegistry.delete(this.id);
    this.listener = null;
    this.buffered.length = 0;
  }

  /** Make the channel serialize to its id when passed via invoke()
   *  args — matches Tauri's behaviour. */
  toJSON(): number { return this.id; }
}

/** Look up a channel by id. Host code uses this to deliver events. */
export function getChannel<T = unknown>(id: number): Channel<T> | undefined {
  return channelRegistry.get(id) as Channel<T> | undefined;
}
