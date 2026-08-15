// Channel — the other direction: events the host pushes at the app.
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
