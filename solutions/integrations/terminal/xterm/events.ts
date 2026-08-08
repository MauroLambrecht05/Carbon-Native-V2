// Tiny event emitter matching xterm.js's `IDisposable`-style listener
// contract. `on*(cb)` returns a disposable; `.dispose()` unsubscribes.
//
//   const emitter = new Emitter<{ data: string }>();
//   const sub = emitter.event(({ data }) => log(data));
//   emitter.fire({ data: "hi" });
//   sub.dispose();

import type { IDisposable } from "./types";

export class Emitter<T> {
  private listeners = new Set<(arg: T) => void>();

  /** Subscribe. Returns a disposable that unsubscribes on `dispose()`. */
  event = (cb: (arg: T) => void): IDisposable => {
    this.listeners.add(cb);
    return {
      dispose: () => { this.listeners.delete(cb); },
    };
  };

  fire(arg: T): void {
    // Snapshot so callbacks that add/remove listeners don't perturb the
    // current iteration.
    for (const cb of Array.from(this.listeners)) {
      try { cb(arg); } catch (e) { console.error("[xterm-shim] listener:", e); }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
