// In-process pub/sub. Same shape as Tauri's `emit`/`listen` so app code
// doesn't change — but the bus is purely local (no IPC). When multi-
// window lands (§4.13), the engine cross-broadcasts emitted events to
// every window automatically; this module's API stays the same.
//
//   const unlisten = await listen<{ value: string }>(
//     "settings-changed",
//     (ev) => console.log(ev.payload.value),
//   );
//   await emit("settings-changed", { value: "dark" });
//   unlisten();

export type EventCallback<T> = (event: { event: string; payload: T }) => void;
export type UnlistenFn = () => void;

interface Listener {
  cb: EventCallback<unknown>;
}

const listeners = new Map<string, Set<Listener>>();

/** Subscribe to events on a channel. The returned promise resolves once
 *  the subscription is live (immediately, in our in-process model). The
 *  resolved value is the unlisten function — call it to stop receiving. */
export async function listen<T>(
  channel: string,
  cb: EventCallback<T>,
): Promise<UnlistenFn> {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  const entry: Listener = { cb: cb as EventCallback<unknown> };
  set.add(entry);
  return () => {
    set!.delete(entry);
    if (set!.size === 0) listeners.delete(channel);
  };
}

/** Publish to a channel. Every registered listener is invoked
 *  synchronously, errors are swallowed so one listener can't block the
 *  others. Resolves immediately. */
export async function emit<T>(channel: string, payload?: T): Promise<void> {
  const set = listeners.get(channel);
  if (!set) return;
  const evt = { event: channel, payload: payload as T };
  for (const l of Array.from(set)) {
    try { (l.cb as EventCallback<T>)(evt); } catch (e) { console.error("[emit]", channel, e); }
  }
}

/** Subscribe once — the listener fires for the first event and then
 *  auto-removes itself. */
export async function once<T>(
  channel: string,
  cb: EventCallback<T>,
): Promise<UnlistenFn> {
  const un = await listen<T>(channel, (e) => {
    un();
    cb(e);
  });
  return un;
}
