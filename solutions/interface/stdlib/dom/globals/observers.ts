// ResizeObserver / IntersectionObserver / MutationObserver /
// PerformanceObserver.
//
// Extracted from install.ts: same reason as storage — `globalThis` only.

export function installObservers(g: any): void {
  // ResizeObserver / IntersectionObserver / MutationObserver — observer
  // APIs that DOM-first libraries use for layout tracking, lazy
  // rendering, and DOM-change detection. Without these, code that
  // constructs them at module init crashes with ReferenceError.
  // No-op observers: register callback, never invoke. Apps that
  // depend on real measurements will silently fail to update — that
  // failure mode is acceptable because the alternative (crash on
  // import) prevents even partial-functionality boots.
  if (typeof (g as any).ResizeObserver === "undefined") {
    // ResizeObserver — delivers an initial entry to the callback on
    // observe(), and re-delivers when the host window is resized
    // (carbon-mini broadcasts via __cm_broadcast_resize, hooked below).
    //
    // Browser semantics that matter here, and that we replicate:
    //
    //   1. **Initial delivery is deferred to the next animation frame.**
    //      CodeMirror / Motion / many measurement-driven libraries call
    //      `observe()` from inside a layout-effect that also writes
    //      state. If we fired the callback synchronously, React would
    //      schedule a render in the same tick, which `observe()`s again
    //      on the next mount cycle — the feedback loop that hung the
    //      reconciler. Browsers break this by batching delivery to a
    //      dedicated "ResizeObserver" cycle on rAF.
    //
    //   2. **Size-equality dedup.** When a callback writes state that
    //      doesn't actually change the observed element's dimensions
    //      (e.g. a parent's flex sibling changes), browsers don't
    //      re-fire. We track last-delivered (w, h) per target and skip
    //      callbacks for unchanged sizes. This stops a write inside the
    //      callback from triggering another observation.
    //
    //   3. **Error isolation.** A throwing callback never poisons future
    //      deliveries — same as the browser spec.
    const activeObservers = new Set<any>();
    const lastSize = new WeakMap<object, { w: number; h: number }>();
    const measure = (target: any): { rect: any; w: number; h: number } => {
      const rect = target.getBoundingClientRect
        ? target.getBoundingClientRect()
        : { x: 0, y: 0, width: 0, height: 0 };
      return { rect, w: rect.width || 0, h: rect.height || 0 };
    };
    const buildEntry = (target: any, rect: any, w: number, h: number): any => ({
      target,
      contentRect: rect,
      borderBoxSize: [{ inlineSize: w, blockSize: h }],
      contentBoxSize: [{ inlineSize: w, blockSize: h }],
      devicePixelContentBoxSize: [{ inlineSize: w, blockSize: h }],
    });
    /** Schedule on the next animation frame, falling back to a microtask
     *  if rAF isn't available yet (during very early init). */
    const onNextFrame = (cb: () => void): void => {
      const raf = (globalThis as any).requestAnimationFrame as
        | ((c: (t: number) => void) => number)
        | undefined;
      if (typeof raf === "function") raf(() => cb());
      else Promise.resolve().then(cb);
    };
    class CarbonResizeObserver {
      private cb: (entries: any[], observer: any) => void;
      private targets: Set<any> = new Set();
      private pendingTargets: Set<any> = new Set();
      private rafPending = false;
      constructor(cb: (entries: any[], observer: any) => void) {
        this.cb = cb;
        activeObservers.add(this);
      }
      observe(target: any, _options?: any): void {
        if (!target) return;
        this.targets.add(target);
        this.pendingTargets.add(target);
        this.scheduleFlush();
      }
      unobserve(target: any): void {
        this.targets.delete(target);
        this.pendingTargets.delete(target);
        lastSize.delete(target);
      }
      disconnect(): void {
        this.targets.clear();
        this.pendingTargets.clear();
        activeObservers.delete(this);
      }
      /** Coalesce pending observe() / _redeliver() calls into one rAF
       *  delivery — that's exactly how browsers batch ResizeObserver. */
      private scheduleFlush(): void {
        if (this.rafPending) return;
        this.rafPending = true;
        onNextFrame(() => {
          this.rafPending = false;
          if (this.pendingTargets.size === 0) return;
          const entries: any[] = [];
          for (const t of this.pendingTargets) {
            const { rect, w, h } = measure(t);
            const prev = lastSize.get(t);
            if (prev && prev.w === w && prev.h === h) continue; // dedup
            lastSize.set(t, { w, h });
            entries.push(buildEntry(t, rect, w, h));
          }
          this.pendingTargets.clear();
          if (entries.length === 0) return;
          try { this.cb(entries, this); }
          catch (e) { console.error("[ResizeObserver] callback threw:", e); }
        });
      }
      /** Internal hook called from __cm_broadcast_resize on window resize.
       *  Queues every observed target for the next batch. */
      _redeliver(): void {
        if (this.targets.size === 0) return;
        for (const t of this.targets) this.pendingTargets.add(t);
        this.scheduleFlush();
      }
    }
    (g as any).ResizeObserver = CarbonResizeObserver;
    if (g.window) g.window.ResizeObserver = CarbonResizeObserver;
    // Hook for the runtime: invoked from __cm_window_dispatch_resize so
    // every observer requeues its targets for the next rAF batch.
    (g as any).__cm_broadcast_resize = () => {
      for (const o of activeObservers) (o as any)._redeliver();
    };
  }
  if (typeof (g as any).IntersectionObserver === "undefined") {
    // Deliver an initial `isIntersecting: true` entry per observed target.
    // xterm.js gates rendering on visibility via IntersectionObserver — a
    // pure no-op would leave the terminal thinking it's offscreen and it
    // would never paint. We treat everything as visible (carbon-mini has
    // no occlusion model), which matches a single always-on window.
    class CarbonIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds: number[] = [0];
      private _cb: (entries: any[], observer: any) => void;
      constructor(cb: (entries: any[], observer: any) => void, _options?: any) {
        this._cb = cb;
      }
      observe(target: any): void {
        const deliver = () => {
          const rect = target?.getBoundingClientRect
            ? target.getBoundingClientRect()
            : { x: 0, y: 0, width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 };
          try {
            this._cb(
              [{
                target,
                isIntersecting: true,
                intersectionRatio: 1,
                boundingClientRect: rect,
                intersectionRect: rect,
                rootBounds: rect,
                time: (globalThis as any).performance?.now?.() ?? Date.now(),
              }],
              this,
            );
          } catch (e) { console.error("[IntersectionObserver] callback threw:", e); }
        };
        const raf = (globalThis as any).requestAnimationFrame as ((cb: () => void) => void) | undefined;
        if (typeof raf === "function") raf(deliver);
        else queueMicrotask(deliver);
      }
      unobserve(_target: any): void {}
      disconnect(): void {}
      takeRecords(): any[] { return []; }
    }
    (g as any).IntersectionObserver = CarbonIntersectionObserver;
    if (g.window) g.window.IntersectionObserver = CarbonIntersectionObserver;
  }
  if (typeof (g as any).MutationObserver === "undefined") {
    class CarbonMutationObserver {
      constructor(_cb: (records: any[], observer: any) => void) {}
      observe(_target: any, _options?: any): void {}
      disconnect(): void {}
      takeRecords(): any[] { return []; }
    }
    (g as any).MutationObserver = CarbonMutationObserver;
    if (g.window) g.window.MutationObserver = CarbonMutationObserver;
  }
  if (typeof (g as any).PerformanceObserver === "undefined") {
    class CarbonPerformanceObserver {
      constructor(_cb: (list: any, observer: any) => void) {}
      observe(_options?: any): void {}
      disconnect(): void {}
      takeRecords(): any[] { return []; }
      static readonly supportedEntryTypes: string[] = [];
    }
    (g as any).PerformanceObserver = CarbonPerformanceObserver;
    if (g.window) g.window.PerformanceObserver = CarbonPerformanceObserver;
  }
}
