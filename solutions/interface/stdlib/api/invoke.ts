// Generic command-invocation channel for app-defined native commands.
//
// The engine ships a registry of named handlers (see carbon/host/native/invoke.rs).
// Each `invoke(name, args)` call serialises `args`,
// hands them to the named Rust handler, and returns whatever it returned.
//
// Channel<T> wraps the engine's streaming dispatchers so a single
// invoke can deliver many messages over time — used for AI HTTP
// streaming, file watchers, anything async with multiple outputs.
//
//   const r = await invoke<{ ok: true }>("fs_create_file", { path });
//   const chan = new Channel<{ delta: string }>();
//   chan.onmessage = (m) => log(m.delta);
//   await invoke("ai_http_stream", { url, body, channel: chan });

import "./hosts";

/** Invoke an app-defined native command. The first arg is the command
 *  name registered on the engine; the second is the args object (serialised
 *  to JSON before crossing the bridge). Result is parsed from JSON. */
export async function invoke<T = unknown>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const argsJson = args === undefined ? "" : JSON.stringify(args);
  const resultJson = __cm_invoke(name, argsJson);
  // Empty string = no result (null-ish commands like window:show).
  if (resultJson === "" || resultJson === undefined) return undefined as T;
  try {
    return JSON.parse(resultJson) as T;
  } catch {
    // Engine returned a non-JSON string; pass through verbatim.
    return resultJson as unknown as T;
  }
}

/** True if a command of the given name is registered on the engine. */
export function hasCommand(name: string): boolean {
  return __cm_invoke_has(name);
}

// ─── Channel — streaming results ─────────────────────────────────────────

let nextChannelId = 1;
const channels = new Map<number, Channel<unknown>>();

/** Streaming sink for commands that emit multiple results over time. The
 *  caller sets `onmessage`; the engine pushes each chunk through. Pass
 *  the Channel as an arg to `invoke()` — the engine reads `.id` to route
 *  dispatches.
 *
 *  Engines route streaming dispatches by Channel id through globally-
 *  installed dispatchers (e.g. `__cm_ai_http_dispatch`). The dispatcher
 *  wrapper in @carbon/mini-react already wraps these in `flushSync`. */
export class Channel<T> {
  /** Unique-per-process id; pass this to native handlers that need to
   *  route stream chunks back to a specific Channel. */
  readonly id: number;
  /** Set by the consumer. Called once per message. */
  onmessage: ((msg: T) => void) | null = null;
  constructor() {
    this.id = nextChannelId++;
    channels.set(this.id, this as unknown as Channel<unknown>);
  }
  /** Internal: invoked by the engine-side dispatcher with a fresh chunk. */
  _push(msg: T): void {
    try { this.onmessage?.(msg); } catch (e) { console.error("[Channel]", e); }
  }
  /** Stop receiving messages. Call when the consumer is done — typically
   *  when the underlying invoke promise resolves or rejects. */
  close(): void {
    channels.delete(this.id);
  }
}

/** Engine-side hook for streaming dispatchers to deliver a chunk to a
 *  Channel by id. Lives on globalThis so any host import can call it
 *  without importing this module. */
(globalThis as unknown as {
  __cm_channel_dispatch?: (id: number, msg: unknown) => void;
}).__cm_channel_dispatch = (id: number, msg: unknown) => {
  channels.get(id)?._push(msg);
};
