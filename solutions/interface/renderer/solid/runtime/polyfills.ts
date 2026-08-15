// polyfills.ts — Browser/Node-style globals required by NPM packages.
// Import this FIRST in any app that uses NPM packages whose top-level
// module-init code touches these globals (lodash, date-fns, etc.).
//
//   import "@carbon/mini-solid/polyfills";
//
// QuickJS provides Date and the carbon-mini host imports only. NPM packages
// commonly call performance.now(), setTimeout, queueMicrotask, or check
// `typeof process` at module-init time. Without these stubs the bundle
// throws before the app can even render.

declare const __cm_request_paint: () => void;

// performance.now(): high-resolution timestamp; Date.now() is fine for
// the precision NPM packages actually need.
if (typeof (globalThis as any).performance === "undefined") {
  (globalThis as any).performance = {
    now() { return Date.now(); },
  };
}

// Node-style globals: many bundled packages assume `process`, `global`.
if (typeof (globalThis as any).global === "undefined") {
  (globalThis as any).global = globalThis;
}
if (typeof (globalThis as any).process === "undefined") {
  (globalThis as any).process = {
    env: { NODE_ENV: "production" },
    nextTick: (cb: () => void) => Promise.resolve().then(cb).catch(() => {}),
    platform: "carbon-mini",
    version: "v0.1.0",
    versions: { node: "0.0.0" },
    hrtime: (() => {
      const fn: any = () => {
        const ms = Date.now();
        return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
      };
      fn.bigint = () => BigInt(Date.now() * 1e6);
      return fn;
    })(),
  };
}

// queueMicrotask: many packages use this. Promise-based fallback works in
// QuickJS since it has native Promise support.
if (typeof (globalThis as any).queueMicrotask === "undefined") {
  (globalThis as any).queueMicrotask = (cb: () => void) => {
    Promise.resolve().then(cb).catch(() => {});
  };
}

// requestAnimationFrame / cancelAnimationFrame — wired to the runtime's
// paint cycle. main.rs's RedrawRequested handler calls
// `globalThis.__cm_drain_raf(timestamp)` at the top of each frame and
// reads `globalThis.__cm_raf_queue.size` afterward to decide whether to
// schedule the next paint (so a self-arming rAF loop keeps running
// without any extra wiring on the JS side).
//
// Drain semantics: snapshot the queue, clear it, then fire each
// callback. Callbacks that re-arm via rAF land in the now-empty queue,
// and the post-paint size check picks them up as "more frames pending".
if (typeof (globalThis as any).requestAnimationFrame === "undefined") {
  const queue = new Map<number, (t: number) => void>();
  (globalThis as any).__cm_raf_queue = queue;
  let nextId = 1;

  (globalThis as any).requestAnimationFrame = (cb: (t: number) => void): number => {
    const id = nextId++;
    queue.set(id, cb);
    __cm_request_paint();
    return id;
  };
  (globalThis as any).cancelAnimationFrame = (id: number) => {
    queue.delete(id);
  };
  (globalThis as any).__cm_drain_raf = (timestamp: number) => {
    if (queue.size === 0) return;
    // Snapshot + clear before firing so re-arming callbacks queue into
    // the next frame, not this one.
    const pending = Array.from(queue.entries());
    queue.clear();
    for (const [, cb] of pending) {
      try { cb(timestamp); } catch (_) { /* swallow per spec */ }
    }
  };
}

// setTimeout / clearTimeout / setInterval / clearInterval — driven by the
// host-provided requestAnimationFrame queue. Resolution ≈ frame interval
// (~16ms) but plenty for the deferred-work patterns NPM packages use.
if (typeof (globalThis as any).setTimeout === "undefined") {
  let timerNextId = 1;
  const timers = new Map<number, { fireAt: number; cb: () => void; interval?: number }>();

  const tickTimers = () => {
    const now = Date.now();
    const due: number[] = [];
    timers.forEach((t, id) => {
      if (now >= t.fireAt) due.push(id);
    });
    due.forEach((id) => {
      const t = timers.get(id);
      if (!t) return;
      try { t.cb(); } catch (e) { /* swallow */ }
      if (t.interval != null) {
        t.fireAt = Date.now() + t.interval;
      } else {
        timers.delete(id);
      }
    });
    if (timers.size > 0) {
      (globalThis as any).requestAnimationFrame(tickTimers);
    }
  };

  (globalThis as any).setTimeout = (cb: () => void, ms?: number, ...args: any[]) => {
    const id = timerNextId++;
    const delay = typeof ms === "number" ? ms : 0;
    timers.set(id, { fireAt: Date.now() + delay, cb: () => cb.apply(null, args as any) });
    if (timers.size === 1 && typeof (globalThis as any).requestAnimationFrame === "function") {
      (globalThis as any).requestAnimationFrame(tickTimers);
    }
    return id;
  };
  (globalThis as any).clearTimeout = (id: number) => { timers.delete(id); };

  (globalThis as any).setInterval = (cb: () => void, ms?: number, ...args: any[]) => {
    const id = timerNextId++;
    const delay = typeof ms === "number" ? ms : 0;
    timers.set(id, { fireAt: Date.now() + delay, cb: () => cb.apply(null, args as any), interval: delay });
    if (timers.size === 1 && typeof (globalThis as any).requestAnimationFrame === "function") {
      (globalThis as any).requestAnimationFrame(tickTimers);
    }
    return id;
  };
  (globalThis as any).clearInterval = (id: number) => { timers.delete(id); };
}

// Crypto stub — QuickJS doesn't provide crypto.getRandomValues. Provide
// a non-cryptographic Math.random fallback so packages like uuid/nanoid
// at least load. Real cryptographic uses should still fail noisily.
if (typeof (globalThis as any).crypto === "undefined") {
  (globalThis as any).crypto = {
    getRandomValues<T extends ArrayBufferView>(array: T): T {
      const view = array as unknown as { length: number; [k: number]: number };
      for (let i = 0; i < view.length; i++) {
        view[i] = Math.floor(Math.random() * 256);
      }
      return array;
    },
    randomUUID(): string {
      const hex = "0123456789abcdef";
      let s = "";
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) s += "-";
        else if (i === 14) s += "4";
        else if (i === 19) s += hex[(Math.random() * 4 | 0) + 8];
        else s += hex[Math.random() * 16 | 0];
      }
      return s;
    },
  };
}

export {};
