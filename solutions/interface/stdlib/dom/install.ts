// install.ts — sets globalThis.{document, window, ...} so DOM-targeting
// frameworks find what they expect when their module-init code runs.
//
// Side-effect import. Should be the FIRST import in the entry bundle so
// frameworks see the globals before their own top-level code touches them:
//
//   import "@carbon/compat-dom/install";
//   import { createRoot } from "react-dom/client";   // would now succeed
//   ...
//
// In practice users don't import this directly — the build pipeline auto-
// prepends it for the React preset.

// `BufferSource` is a lib.dom alias, and this package cannot take lib DOM —
// it IS the DOM shim, so lib DOM's declarations of the globals defined below
// would collide with them. The one name actually needed is spelled out here.
type BufferSource = ArrayBufferView | ArrayBuffer;

import {
  CarbonDocument,
  CarbonElement,
  CarbonText,
  CarbonComment,
  CarbonDocumentFragment,
  CarbonNode,
  CarbonEvent,
  CarbonMouseEvent,
  CarbonKeyboardEvent,
  CarbonWheelEvent,
  nodeRegistry,
} from "./node.ts";
import {
  CarbonCanvasContext2D,
  CarbonCanvasGradient,
  CarbonImageData,
  CarbonOffscreenCanvas,
} from "./canvas.ts";

declare const __cm_request_paint: () => void;
declare const __cm_window_inner_width: (() => number) | undefined;
declare const __cm_window_inner_height: (() => number) | undefined;
declare const __cm_window_device_pixel_ratio: (() => number) | undefined;

const g = globalThis as any;

// Legacy keyCode/which derivation from a KeyboardEvent.key value. xterm.js
// (and CodeMirror, Monaco, etc.) branch on keyCode for non-printable keys,
// so the keydown bridge must supply it.
const _KEYCODE: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
  Pause: 19, CapsLock: 20, Escape: 27, " ": 32, Spacebar: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118,
  F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};
// Physical keyCodes for US-layout punctuation / symbols. The keyCode
// reflects the PHYSICAL KEY, so a glyph and its shifted glyph share one code
// (e.g. `'` and `"` are both 222). This matters for two reasons xterm cares
// about:
//   1. Many symbols' character codes collide with named-key codes — `'`
//      is charCode 39 = ArrowRight, `(` is 40 = ArrowDown, `{` is 123 = F12.
//      Returning the character code made typing them fire cursor moves / F12.
//   2. xterm only treats a keydown as printable when keyCode >= 48, so a
//      symbol whose character code is < 48 (`"`=34, `!`=33, …) was dropped.
// The real physical codes are all >= 48 and avoid the named-key cases.
const _PUNCT_KEYCODE: Record<string, number> = {
  ";": 186, ":": 186,
  "=": 187, "+": 187,
  ",": 188, "<": 188,
  "-": 189, "_": 189,
  ".": 190, ">": 190,
  "/": 191, "?": 191,
  "`": 192, "~": 192,
  "[": 219, "{": 219,
  "\\": 220, "|": 220,
  "]": 221, "}": 221,
  "'": 222, '"': 222,
  // Shifted digit row → the digit's own physical key.
  "!": 49, "@": 50, "#": 51, "$": 52, "%": 53,
  "^": 54, "&": 55, "*": 56, "(": 57, ")": 48,
};
function keyToKeyCode(key: string): number {
  if (key in _KEYCODE) return _KEYCODE[key];
  if (key.length === 1) {
    if (key in _PUNCT_KEYCODE) return _PUNCT_KEYCODE[key];
    // Letters A-Z → 65-90, digits 0-9 → 48-57 already match their key code.
    return key.toUpperCase().charCodeAt(0);
  }
  return 0;
}
function keyToCode(key: string): string {
  if (key.length === 1) {
    const u = key.toUpperCase();
    if (u >= "A" && u <= "Z") return "Key" + u;
    if (key >= "0" && key <= "9") return "Digit" + key;
    if (key === " ") return "Space";
  }
  if (key === " ") return "Space";
  if (key.startsWith("Arrow") || key.length > 1) return key;
  return "";
}

// App-level helpers (SimpleContextMenu, etc.) need to walk parent chains
// from a runtime-hit-tested node up to a known ancestor. Expose the
// registry through globalThis so they don't need to import the shim
// package directly.
g.__cm_node_registry = nodeRegistry;

if (!g.document) {
  const doc = new CarbonDocument();
  g.document = doc;

  // Typed HTMLElement subclasses for form controls. Libraries reach for the
  // *native* value/checked setter off the constructor's prototype to drive a
  // controlled input and dispatch a change — e.g. Radix UI's checkbox/switch:
  //   const setter = Object.getOwnPropertyDescriptor(
  //     window.HTMLInputElement.prototype, "checked").set;
  //   setter.call(hiddenInput, nextChecked); hiddenInput.dispatchEvent(evt);
  // and React's controlled-input tracker does the same for "value". Without
  // these (HTMLInputElement was simply undefined) that threw
  // "cannot read property 'prototype' of undefined" and the whole component
  // subtree failed to render (broke the entire Settings window). The setter
  // runs against a real CarbonElement instance, so it just round-trips through
  // setAttribute/getAttribute — which the engine already honors.
  class CarbonHTMLInputElement extends CarbonElement {}
  class CarbonHTMLTextAreaElement extends CarbonElement {}
  class CarbonHTMLSelectElement extends CarbonElement {}
  const defineFormProp = (proto: object, name: "checked" | "value") => {
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: false,
      get(this: any) {
        if (name === "checked") return this.getAttribute?.("checked") != null;
        return this.getAttribute?.("value") ?? "";
      },
      set(this: any, v: any) {
        if (name === "checked") {
          if (v) this.setAttribute?.("checked", "");
          else this.removeAttribute?.("checked");
        } else {
          this.setAttribute?.("value", v == null ? "" : String(v));
        }
      },
    });
  };
  defineFormProp(CarbonHTMLInputElement.prototype, "checked");
  defineFormProp(CarbonHTMLInputElement.prototype, "value");
  defineFormProp(CarbonHTMLTextAreaElement.prototype, "value");
  defineFormProp(CarbonHTMLSelectElement.prototype, "value");

  // Standard NodeFilter constant bag (used with document.createTreeWalker).
  const NODE_FILTER = {
    FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
    SHOW_ALL: 0xffffffff, SHOW_ELEMENT: 0x1, SHOW_ATTRIBUTE: 0x2,
    SHOW_TEXT: 0x4, SHOW_CDATA_SECTION: 0x8, SHOW_ENTITY_REFERENCE: 0x10,
    SHOW_ENTITY: 0x20, SHOW_PROCESSING_INSTRUCTION: 0x40, SHOW_COMMENT: 0x80,
    SHOW_DOCUMENT: 0x100, SHOW_DOCUMENT_TYPE: 0x200,
    SHOW_DOCUMENT_FRAGMENT: 0x400, SHOW_NOTATION: 0x800,
  };

  // window — the bare minimum properties frameworks check for.
  const win = {
    document: doc,
    location: {
      href: "carbon-mini://app/",
      protocol: "carbon-mini:",
      host: "app",
      hostname: "app",
      port: "",
      pathname: "/",
      search: "",
      hash: "",
      origin: "carbon-mini://app",
      assign() {}, replace() {}, reload() {}, toString() { return this.href; },
    },
    history: {
      length: 1, state: null,
      pushState() {}, replaceState() {}, go() {}, back() {}, forward() {},
    },
    navigator: {
      userAgent: "carbon-mini/0.1 (no-webview)",
      language: "en-US",
      languages: ["en-US", "en"],
      onLine: true,
      platform: "carbon-mini",
      hardwareConcurrency: 1,
      maxTouchPoints: 0,
      vendor: "carbon",
      product: "Gecko",
      cookieEnabled: false,
      clipboard: undefined,
    },
    screen: {
      width: 1100, height: 720, availWidth: 1100, availHeight: 720,
      colorDepth: 24, pixelDepth: 24,
    },
    // innerWidth / innerHeight / devicePixelRatio / outer* mirror the
    // real window state via the runtime host imports. Radix's Floating
    // UI middleware and other layout libs read these every time a
    // popover positions itself; serving stale 1100×720 values broke
    // every dropdown's collision detection. We expose getters so each
    // read fetches the live size — cheap (one host-import call) and
    // always correct after a resize.
    // NOTE: pinned to 1. carbon-mini's scene paints in CSS/logical pixels
    // (the rasterizer handles physical scaling), so JS-side code must treat
    // the canvas coordinate space as 1:1. xterm's canvas renderer in
    // particular multiplies cell metrics by devicePixelRatio to build its
    // glyph atlas at device resolution; with a fractional system scale
    // (Windows 125%/150%) that left every glyph scaled by a non-integer
    // factor and the terminal rendered as garbled, mis-width text. Reporting
    // 1 keeps the atlas 1:1 with our composited output.
    get devicePixelRatio(): number { return 1; },
    get innerWidth(): number {
      try { return typeof __cm_window_inner_width === "function" ? __cm_window_inner_width() : 1100; }
      catch { return 1100; }
    },
    get innerHeight(): number {
      try { return typeof __cm_window_inner_height === "function" ? __cm_window_inner_height() : 720; }
      catch { return 720; }
    },
    get outerWidth(): number {
      try { return typeof __cm_window_inner_width === "function" ? __cm_window_inner_width() : 1100; }
      catch { return 1100; }
    },
    get outerHeight(): number {
      try { return typeof __cm_window_inner_height === "function" ? __cm_window_inner_height() : 720; }
      catch { return 720; }
    },
    scrollX: 0,
    scrollY: 0,
    pageXOffset: 0,
    pageYOffset: 0,
    addEventListener(type: string, listener: any) {
      doc.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: any) {
      doc.removeEventListener(type, listener);
    },
    dispatchEvent(e: any) { return doc.dispatchEvent(e); },
    // Resolve computed style by reading the element's own inline style and
    // expanding `var(--token)` references through the engine's theme
    // resolver. The old stub returned "" for everything, which broke the
    // common token-probe pattern (`el.style.color = "var(--background)";
    // getComputedStyle(el).color`) that libraries like xterm.js + CodeMirror
    // use to turn CSS custom properties into concrete colors — leaving the
    // terminal/editor with empty (→ default black) colors.
    getComputedStyle(el?: any) {
      const expand = (raw: unknown): string => {
        if (typeof raw !== "string" || raw.length === 0) return "";
        const m = /var\(\s*--([A-Za-z0-9-]+)/.exec(raw);
        if (!m) return raw;
        const token = m[1];
        try {
          const resolver = (globalThis as any).__cm_resolve_class as
            | ((cls: string) => { color?: string; background?: string } | null)
            | undefined;
          const r = resolver?.("text-" + token);
          if (r && typeof r.color === "string" && r.color) return r.color;
          const b = resolver?.("bg-" + token);
          if (b && typeof b.background === "string" && b.background) return b.background;
        } catch { /* fall through */ }
        // var() with a literal fallback: var(--x, #fff) → use the fallback.
        const fb = /,\s*([^)]+)\)/.exec(raw);
        return fb ? fb[1].trim() : "";
      };
      // Box-metric lengths (padding/margin/border-width) must read back as a
      // parseable pixel value, NOT "". xterm.js maps mouse coordinates to
      // cells with `parseInt(getComputedStyle(el).getPropertyValue(
      // "padding-left"))` — an empty string yields NaN, which propagated
      // into NaN cell coords (garbled SGR mouse reports) and broke drag
      // selection (same code path). Real browsers always return a concrete
      // length here, so we default unset box metrics to "0px".
      const isZeroLength = (prop: string): boolean => {
        const k = prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
        return /^(padding|margin)(-(top|right|bottom|left))?$/.test(k)
          || /^border(-(top|right|bottom|left))?-width$/.test(k);
      };
      const read = (prop: string): string => {
        // Used width/height resolve to the element's laid-out box (what a
        // browser returns). xterm's FitAddon sizes the grid from
        // `parseInt(getComputedStyle(parent).getPropertyValue("width"))`; a
        // flex/`w-full` parent has no inline width, so reading inline style
        // gave "" → NaN cols/rows → the fit was skipped and the terminal
        // stayed at the default 80×24 instead of filling the pane.
        if (el && (prop === "width" || prop === "height" || prop === "inline-size" || prop === "block-size")) {
          try {
            const rect = el.getBoundingClientRect?.();
            if (rect) {
              const px = prop === "width" || prop === "inline-size" ? rect.width : rect.height;
              if (px > 0) return `${px}px`;
            }
          } catch { /* fall through to inline style */ }
        }
        const st = el?.style;
        const raw = st
          ? (typeof st.getPropertyValue === "function" ? st.getPropertyValue(prop) : st[prop])
          : "";
        const v = expand(raw);
        if (v === "" && isZeroLength(prop)) return "0px";
        return v;
      };
      return new Proxy({}, {
        get(_t, prop) {
          if (prop === "getPropertyValue") return (p: string) => read(String(p));
          return read(String(prop));
        },
      });
    },
    getSelection() {
      // CodeMirror reads window.getSelection() to mirror the DOM caret.
      // Delegate to the document's inert selection (see CarbonDocument).
      return (doc as any).getSelection?.() ?? null;
    },
    matchMedia(_q: string) {
      return {
        matches: false,
        media: _q,
        onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
        dispatchEvent() { return false; },
      };
    },
    requestAnimationFrame(cb: (t: number) => void): number {
      // We don't have a real frame clock yet; deferred via setTimeout
      // (which itself is a polyfill in @carbon/mini-solid/polyfills).
      // ~16 ms emulates 60 fps for libraries that try to drive their own
      // animation loops.
      const t = setTimeout(() => cb(Date.now()), 16);
      return t as unknown as number;
    },
    cancelAnimationFrame(id: number) {
      clearTimeout(id);
    },
    setTimeout: g.setTimeout ?? ((cb: () => void, _ms?: number) => { Promise.resolve().then(cb); return 0; }),
    clearTimeout: g.clearTimeout ?? (() => {}),
    setInterval: g.setInterval ?? (() => 0),
    clearInterval: g.clearInterval ?? (() => {}),
    queueMicrotask: g.queueMicrotask ?? ((cb: () => void) => { Promise.resolve().then(cb); }),
    crypto: g.crypto,
    performance: g.performance,
    process: g.process,
    Image: function Image() { return new CarbonElement("img"); },
    requestIdleCallback(cb: () => void) {
      const t = setTimeout(() => cb(), 1);
      return t as unknown as number;
    },
    cancelIdleCallback(id: number) { clearTimeout(id); },
    self: undefined as any,
    top: undefined as any,
    parent: undefined as any,
    window: undefined as any,
    globalThis: g,
    HTMLElement: CarbonElement,
    HTMLInputElement: CarbonHTMLInputElement,
    HTMLTextAreaElement: CarbonHTMLTextAreaElement,
    HTMLSelectElement: CarbonHTMLSelectElement,
    Element: CarbonElement,
    Node: CarbonNode,
    // NodeFilter constants — required by document.createTreeWalker callers
    // (Radix focus-scope tab-trapping). Plain constant bag, like the browser's.
    NodeFilter: NODE_FILTER,
    Text: CarbonText,
    Comment: CarbonComment,
    DocumentFragment: CarbonDocumentFragment,
    Event: CarbonEvent,
    MouseEvent: CarbonMouseEvent,
    KeyboardEvent: CarbonKeyboardEvent,
    WheelEvent: CarbonWheelEvent,
    CustomEvent: CarbonEvent,
  };
  win.self = win;
  win.top = win;
  win.parent = win;
  win.window = win;
  doc.defaultView = win;
  g.window = win;

  // Hoist the canonical constructors onto globalThis as well so unscoped
  // references (`new Event(...)` without `window.` prefix) work in code
  // that wasn't written for browser-only environments.
  g.Node = CarbonNode;
  g.Element = CarbonElement;
  g.HTMLElement = CarbonElement;
  g.HTMLInputElement = CarbonHTMLInputElement;
  g.HTMLTextAreaElement = CarbonHTMLTextAreaElement;
  g.HTMLSelectElement = CarbonHTMLSelectElement;
  g.NodeFilter = NODE_FILTER;
  g.Text = CarbonText;
  g.Comment = CarbonComment;
  g.DocumentFragment = CarbonDocumentFragment;
  g.Event = CarbonEvent;
  g.MouseEvent = CarbonMouseEvent;
  g.KeyboardEvent = CarbonKeyboardEvent;
  g.WheelEvent = CarbonWheelEvent;
  g.CustomEvent = CarbonEvent;
  // Do NOT clobber the engine's frame-synced requestAnimationFrame. The
  // runtime installs an rAF that queues callbacks into the paint loop and
  // drains them every RedrawRequested (see carbon/runtime/mini.rs __cm_drain_raf).
  // Our setTimeout(16) fallback only works when the engine didn't provide
  // one — and its timer never fires while the event loop sits in
  // ControlFlow::Wait, which silently stalls any library render loop driven
  // by rAF (xterm's flushRender, framer-motion, etc.). Keep the engine's,
  // install ours only as a fallback, and point `window.*` at whichever won.
  if (typeof g.requestAnimationFrame !== "function") {
    g.requestAnimationFrame = win.requestAnimationFrame;
    g.cancelAnimationFrame = win.cancelAnimationFrame;
  }
  win.requestAnimationFrame = g.requestAnimationFrame;
  win.cancelAnimationFrame = g.cancelAnimationFrame;
  g.requestIdleCallback = win.requestIdleCallback;
  g.cancelIdleCallback = win.cancelIdleCallback;
  g.matchMedia = win.matchMedia;
  g.getComputedStyle = win.getComputedStyle;
  g.location = win.location;
  g.history = win.history;
  g.navigator = win.navigator;

  // Window-resize bridge: when the runtime fires
  // `__cm_window_dispatch_resize()` after a tao Resized event, we (a)
  // re-fire every ResizeObserver subscriber via the broadcast hook
  // installed below, and (b) dispatch a DOM `resize` event on window
  // so libraries listening through `window.addEventListener('resize',
  // ...)` (Motion, react-resizable-panels, charting libs) are notified.
  // Chained via the `prev?.()` pattern so the original Solid
  // mini-runtime's resize listeners keep firing too.
  {
    const prevResize = g.__cm_window_dispatch_resize as (() => void) | undefined;
    g.__cm_window_dispatch_resize = () => {
      try { prevResize?.(); } catch { /* keep going */ }
      try {
        const broadcast = g.__cm_broadcast_resize as (() => void) | undefined;
        broadcast?.();
      } catch { /* swallow */ }
      try { doc.dispatchEvent(new CarbonEvent("resize")); } catch { /* swallow */ }
    };
  }

  // Keyboard bridge: the runtime calls `__cm_dispatch_keydown(key, ctrl,
  // shift, alt, meta)` on every key press. Translate that into a real DOM
  // `keydown` KeyboardEvent dispatched on `document`, which is where
  // `window.addEventListener("keydown", …)` parks its listeners
  // (window.addEventListener delegates to doc.addEventListener above).
  // Without this every `useGlobalShortcuts`-style hook is silent in
  // carbon-mini. The wrapper installed by @carbon/mini-react auto-wraps
  // this in `flushSync` so setState() from inside a shortcut handler
  // commits before the next paint — we don't have to worry about it
  // here. The original Solid `mini-runtime` package installs its own
  // `keydownListeners` dispatcher; the chain pattern (`prev?.()`)
  // ensures both fire when both packages load.
  {
    const prev = g.__cm_dispatch_keydown as
      | ((k: string, c: boolean, s: boolean, a: boolean, m: boolean) => void)
      | undefined;
    g.__cm_dispatch_keydown = (
      key: string,
      ctrl: boolean,
      shift: boolean,
      alt: boolean,
      meta: boolean,
    ) => {
      try { prev?.(key, ctrl, shift, alt, meta); } catch { /* keep going */ }
      const keyCode = keyToKeyCode(key);
      const ev = new CarbonKeyboardEvent("keydown", {
        key,
        code: keyToCode(key),
        keyCode,
        which: keyCode,
        ctrlKey: ctrl,
        shiftKey: shift,
        altKey: alt,
        metaKey: meta,
        bubbles: true,
        cancelable: true,
      });
      // Dispatch on the focused element (e.g. xterm's hidden textarea) so its
      // own keydown listener fires; the event bubbles up to `document` so
      // global shortcuts still work. Falls back to document when nothing is
      // focused.
      const target = (doc.activeElement as any) || doc;
      try { target.dispatchEvent(ev); } catch { /* swallow listener errors */ }

      // Browser parity: a printable key the keydown listener did NOT consume
      // (didn't preventDefault) is delivered by a follow-up `keypress` that
      // carries the real character code. xterm.js relies on this for space,
      // uppercase letters, and any symbol it skips on keydown — its keydown
      // path only emits printables with keyCode >= 48, and `_keyPress` reads
      // `charCode`/`which` (the character), not the physical keyCode. A real
      // browser suppresses keypress after a preventDefaulted keydown, so the
      // `!defaultPrevented` gate is what keeps already-sent keys (lowercase
      // letters, digits, symbols) from being typed twice.
      if (!ev.defaultPrevented && !ctrl && !meta && key.length === 1) {
        const cp = key.charCodeAt(0);
        if (cp >= 32) {
          const kp = new CarbonKeyboardEvent("keypress", {
            key,
            code: keyToCode(key),
            keyCode: cp,
            which: cp,
            charCode: cp,
            ctrlKey: ctrl,
            shiftKey: shift,
            altKey: alt,
            metaKey: meta,
            bubbles: true,
            cancelable: true,
          });
          try { target.dispatchEvent(kp); } catch { /* swallow listener errors */ }
        }
      }
    };
  }

  // localStorage / sessionStorage — in-memory shim. React-DOM checks
  // localStorage at module init for the theme-cookie path; libraries
  // like next-themes / zustand-persist read/write these constantly.
  // Persistence across sessions would need wiring to carbon-mini's
  // Store; for now apps that want durable storage should use
  // `new Store(...)` directly.
  const makeStorage = () => {
    const data = new Map<string, string>();
    return {
      getItem(key: string): string | null { return data.has(key) ? data.get(key)! : null; },
      setItem(key: string, value: string): void { data.set(key, String(value)); },
      removeItem(key: string): void { data.delete(key); },
      clear(): void { data.clear(); },
      key(i: number): string | null {
        const keys = Array.from(data.keys());
        return keys[i] ?? null;
      },
      get length(): number { return data.size; },
    };
  };
  if (typeof (g as any).localStorage === "undefined") {
    const ls = makeStorage();
    (g as any).localStorage = ls;
    if (g.window) g.window.localStorage = ls;
  }
  if (typeof (g as any).sessionStorage === "undefined") {
    const ss = makeStorage();
    (g as any).sessionStorage = ss;
    if (g.window) g.window.sessionStorage = ss;
  }

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

  // Canvas 2D primitives. <canvas>.getContext('2d') is wired per-element in
  // node.ts (createElement). These globals satisfy `new OffscreenCanvas()`,
  // `new ImageData()`, `instanceof CanvasRenderingContext2D` / `CanvasGradient`
  // checks, and `new Path2D()` (a minimal stub) that canvas libraries do at
  // module-init. The real drawing is backed by canvas2d.rs.
  if (typeof (g as any).OffscreenCanvas === "undefined") {
    (g as any).OffscreenCanvas = CarbonOffscreenCanvas;
    if (g.window) g.window.OffscreenCanvas = CarbonOffscreenCanvas;
  }
  if (typeof (g as any).ImageData === "undefined") {
    (g as any).ImageData = CarbonImageData;
    if (g.window) g.window.ImageData = CarbonImageData;
  }
  if (typeof (g as any).CanvasRenderingContext2D === "undefined") {
    (g as any).CanvasRenderingContext2D = CarbonCanvasContext2D;
    if (g.window) g.window.CanvasRenderingContext2D = CarbonCanvasContext2D;
  }
  if (typeof (g as any).OffscreenCanvasRenderingContext2D === "undefined") {
    (g as any).OffscreenCanvasRenderingContext2D = CarbonCanvasContext2D;
  }
  if (typeof (g as any).CanvasGradient === "undefined") {
    (g as any).CanvasGradient = CarbonCanvasGradient;
    if (g.window) g.window.CanvasGradient = CarbonCanvasGradient;
  }
  // createImageBitmap — xterm's canvas renderer turns its glyph-atlas
  // <canvas> into an ImageBitmap for fast drawImage blits. We model an
  // ImageBitmap as a lightweight handle to the SAME backing surface (the
  // atlas is append-only, so sharing the live surface is correct and
  // avoids a full pixel copy). drawImage reads `__cmSurfaceId` off it.
  if (typeof (g as any).createImageBitmap === "undefined") {
    const createImageBitmap = (source: any): Promise<any> => {
      const surfaceId = source?.__cmSurfaceId ?? source?.cmId;
      const bitmap = {
        __cmSurfaceId: surfaceId,
        width: source?.width ?? 0,
        height: source?.height ?? 0,
        close() {},
      };
      return Promise.resolve(bitmap);
    };
    (g as any).createImageBitmap = createImageBitmap;
    if (g.window) g.window.createImageBitmap = createImageBitmap;
  }
  // devicePixelRatio on globalThis/self (window already exposes a getter).
  // Canvas libraries read it off whichever global they reach for.
  if (typeof (g as any).devicePixelRatio === "undefined") {
    try {
      Object.defineProperty(g, "devicePixelRatio", {
        configurable: true,
        get(): number {
          try { return g.window ? g.window.devicePixelRatio : 1; } catch { return 1; }
        },
      });
    } catch { (g as any).devicePixelRatio = 1; }
  }
  if (typeof (g as any).Path2D === "undefined") {
    class CarbonPath2D {
      addPath(): void {}
      closePath(): void {}
      moveTo(): void {}
      lineTo(): void {}
      bezierCurveTo(): void {}
      quadraticCurveTo(): void {}
      arc(): void {}
      arcTo(): void {}
      ellipse(): void {}
      rect(): void {}
      roundRect(): void {}
    }
    (g as any).Path2D = CarbonPath2D;
    if (g.window) g.window.Path2D = CarbonPath2D;
  }

  // document.fonts — FontFaceSet stub. xterm.js + many CSS-typography
  // libraries await `document.fonts.ready` before laying out text. We
  // resolve immediately because the runtime ships its own pre-loaded
  // font set (Inter / JetBrains Mono) via fontdue; nothing JS-side
  // needs to wait for a load event.
  if (!(doc as unknown as { fonts?: unknown }).fonts) {
    const readyP = Promise.resolve();
    const fontsStub = {
      ready: readyP,
      status: "loaded" as const,
      size: 0,
      add() {},
      delete() { return true; },
      clear() {},
      check() { return true; },
      load() { return Promise.resolve([]); },
      forEach() {},
      values: function* () {},
      keys: function* () {},
      entries: function* () {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
    };
    (doc as unknown as { fonts: typeof fontsStub }).fonts = fontsStub;
  }

  // Repaint after install so anything painted during init flushes.
  if (typeof __cm_request_paint === "function") __cm_request_paint();
}



// ─── Web Streams shim ─────────────────────────────────────────────────────
//
// AI SDK + fetch use ReadableStream / WritableStream / TransformStream
// pervasively. QuickJS doesn't ship them; without these polyfills,
// `new TransformStream()` throws ReferenceError during module init.
// Minimal but functional: covers the standard subset that streaming
// HTTP, async iteration, and pipe chains need.
if (typeof (g as any).ReadableStream === "undefined") {
  class CarbonReadableStream<T = unknown> {
    private chunks: T[] = [];
    private ended = false;
    private errored: unknown = null;
    private pullCb: ((c: any) => any) | null = null;
    private cancelCb: ((r: unknown) => any) | null = null;
    private pendingReader: ((v: { value: T | undefined; done: boolean }) => void) | null = null;
    private pendingRejector: ((e: unknown) => void) | null = null;
    locked = false;

    constructor(source?: {
      start?: (c: any) => any;
      pull?: (c: any) => any;
      cancel?: (r: unknown) => any;
    }) {
      this.pullCb = source?.pull ?? null;
      this.cancelCb = source?.cancel ?? null;
      const controller = {
        enqueue: (chunk: T) => this._push(chunk),
        close: () => this._close(),
        error: (e: unknown) => this._error(e),
        desiredSize: 1,
      };
      try { source?.start?.(controller); } catch (e) { this._error(e); }
    }

    private _push(chunk: T) {
      if (this.pendingReader) {
        const r = this.pendingReader; this.pendingReader = null; this.pendingRejector = null;
        r({ value: chunk, done: false });
      } else {
        this.chunks.push(chunk);
      }
    }
    private _close() {
      this.ended = true;
      if (this.pendingReader) {
        const r = this.pendingReader; this.pendingReader = null; this.pendingRejector = null;
        r({ value: undefined, done: true });
      }
    }
    private _error(e: unknown) {
      this.errored = e;
      if (this.pendingRejector) {
        const rej = this.pendingRejector; this.pendingReader = null; this.pendingRejector = null;
        rej(e);
      }
    }

    getReader() {
      this.locked = true;
      const self = this;
      return {
        read(): Promise<{ value: T | undefined; done: boolean }> {
          if (self.errored) return Promise.reject(self.errored);
          if (self.chunks.length > 0) {
            return Promise.resolve({ value: self.chunks.shift(), done: false });
          }
          if (self.ended) return Promise.resolve({ value: undefined, done: true });
          // Ask source for more, then await a push.
          if (self.pullCb) {
            try { self.pullCb({ enqueue: (c: T) => self._push(c), close: () => self._close(), error: (e: any) => self._error(e), desiredSize: 1 }); } catch (e) { self._error(e); }
            if (self.errored) return Promise.reject(self.errored);
            if (self.chunks.length > 0) return Promise.resolve({ value: self.chunks.shift(), done: false });
            if (self.ended) return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve, reject) => {
            self.pendingReader = resolve;
            self.pendingRejector = reject;
          });
        },
        cancel(reason: unknown) {
          self.locked = false;
          self.cancelCb?.(reason);
          self.ended = true;
          return Promise.resolve();
        },
        releaseLock() { self.locked = false; },
        get closed(): Promise<undefined> {
          return new Promise((resolve, reject) => {
            const tick = () => {
              if (self.errored) reject(self.errored);
              else if (self.ended) resolve(undefined);
              else setTimeout(tick, 16);
            };
            tick();
          });
        },
      };
    }

    cancel(reason?: unknown) {
      this.cancelCb?.(reason);
      this.ended = true;
      return Promise.resolve();
    }

    pipeThrough<U>(transform: { readable: CarbonReadableStream<U>; writable: CarbonWritableStream<T> }) {
      // Pump self → transform.writable; return transform.readable.
      const writer = transform.writable.getWriter();
      const reader = this.getReader();
      const pump = () => {
        reader.read().then((r: any) => {
          if (r.done) { writer.close(); return; }
          writer.write(r.value).then(pump).catch((e) => writer.abort(e));
        }).catch((e) => writer.abort(e));
      };
      pump();
      return transform.readable;
    }

    pipeTo(dest: CarbonWritableStream<T>) {
      const writer = dest.getWriter();
      const reader = this.getReader();
      return new Promise<void>((resolve, reject) => {
        const pump = () => {
          reader.read().then((r: any) => {
            if (r.done) { writer.close().then(() => resolve()).catch(reject); return; }
            writer.write(r.value).then(pump).catch(reject);
          }).catch(reject);
        };
        pump();
      });
    }

    [Symbol.asyncIterator]() {
      const reader = this.getReader();
      return {
        next() { return reader.read(); },
        return() { reader.releaseLock(); return Promise.resolve({ value: undefined, done: true }); },
        [Symbol.asyncIterator]() { return this; },
      };
    }
  }

  class CarbonWritableStream<T = unknown> {
    private writeCb: ((c: T, ctrl: any) => any) | null = null;
    private closeCb: ((ctrl?: any) => any) | null = null;
    private abortCb: ((r: unknown) => any) | null = null;
    locked = false;

    constructor(sink?: {
      start?: (c: any) => any;
      write?: (c: T, ctrl: any) => any;
      close?: (ctrl?: any) => any;
      abort?: (r: unknown) => any;
    }) {
      this.writeCb = sink?.write ?? null;
      this.closeCb = sink?.close ?? null;
      this.abortCb = sink?.abort ?? null;
      const ctrl = { error: (e: unknown) => { this.abortCb?.(e); } };
      try { sink?.start?.(ctrl); } catch (_) {}
    }

    getWriter() {
      this.locked = true;
      const self = this;
      const ctrl = { error: (e: unknown) => { self.abortCb?.(e); } };
      return {
        write(chunk: T) {
          if (!self.writeCb) return Promise.resolve();
          try {
            const r = self.writeCb(chunk, ctrl);
            return r instanceof Promise ? r : Promise.resolve();
          } catch (e) { return Promise.reject(e); }
        },
        close() {
          if (!self.closeCb) return Promise.resolve();
          try {
            const r = self.closeCb(ctrl);
            return r instanceof Promise ? r : Promise.resolve();
          } catch (e) { return Promise.reject(e); }
        },
        abort(reason: unknown) {
          self.abortCb?.(reason);
          return Promise.resolve();
        },
        releaseLock() { self.locked = false; },
        get closed(): Promise<undefined> { return Promise.resolve(undefined); },
        get desiredSize() { return 1; },
        get ready(): Promise<undefined> { return Promise.resolve(undefined); },
      };
    }
  }

  class CarbonTransformStream<I = unknown, O = unknown> {
    readable: CarbonReadableStream<O>;
    writable: CarbonWritableStream<I>;

    constructor(transformer?: {
      start?: (c: any) => any;
      transform?: (chunk: I, c: any) => any;
      flush?: (c: any) => any;
    }) {
      let readableCtrl: any = null;
      this.readable = new CarbonReadableStream<O>({
        start(c) { readableCtrl = c; },
      });
      const controller = {
        enqueue: (chunk: O) => readableCtrl?.enqueue(chunk),
        error: (e: unknown) => readableCtrl?.error(e),
        terminate: () => readableCtrl?.close(),
      };
      try { transformer?.start?.(controller); } catch (e) { readableCtrl?.error(e); }
      this.writable = new CarbonWritableStream<I>({
        write(chunk, _ctrl) {
          if (!transformer?.transform) {
            readableCtrl?.enqueue(chunk as any);
            return Promise.resolve();
          }
          try {
            const r = transformer.transform(chunk, controller);
            return r instanceof Promise ? r : Promise.resolve();
          } catch (e) { readableCtrl?.error(e); return Promise.reject(e); }
        },
        close() {
          try {
            transformer?.flush?.(controller);
            readableCtrl?.close();
          } catch (e) { readableCtrl?.error(e); }
          return Promise.resolve();
        },
        abort(reason) {
          readableCtrl?.error(reason);
          return Promise.resolve();
        },
      });
    }
  }

  (g as any).ReadableStream = CarbonReadableStream;
  (g as any).WritableStream = CarbonWritableStream;
  (g as any).TransformStream = CarbonTransformStream;

  // TextEncoder / TextDecoder — required by streams, fetch, and AI SDK.
  // QuickJS doesn't ship them. Standards-compliant UTF-8 implementation;
  // no other encodings supported (which matches the WHATWG spec for
  // TextEncoder, which is UTF-8-only). TextDecoder accepts any label
  // but treats everything as UTF-8 — apps that need real ISO-8859 etc.
  // should bring their own decoder.
  if (typeof (g as any).TextEncoder === "undefined") {
    class CarbonTextEncoder {
      readonly encoding = "utf-8";
      encode(input = ""): Uint8Array {
        const s = String(input);
        const out: number[] = [];
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const c2 = s.charCodeAt(i + 1);
            if (c2 >= 0xdc00 && c2 <= 0xdfff) {
              c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
              i++;
            }
          }
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
        return new Uint8Array(out);
      }
      encodeInto(source: string, dest: Uint8Array): { read: number; written: number } {
        const bytes = this.encode(source);
        const n = Math.min(bytes.length, dest.length);
        for (let i = 0; i < n; i++) dest[i] = bytes[i];
        return { read: source.length, written: n };
      }
    }
    class CarbonTextDecoder {
      readonly encoding: string;
      readonly fatal: boolean;
      readonly ignoreBOM: boolean;
      constructor(label = "utf-8", options?: { fatal?: boolean; ignoreBOM?: boolean }) {
        this.encoding = String(label).toLowerCase();
        this.fatal = !!options?.fatal;
        this.ignoreBOM = !!options?.ignoreBOM;
      }
      decode(input?: BufferSource | null, _options?: { stream?: boolean }): string {
        if (!input) return "";
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) bytes = input;
        else if ((input as any).buffer) bytes = new Uint8Array((input as any).buffer, (input as any).byteOffset || 0, (input as any).byteLength);
        else bytes = new Uint8Array(input as ArrayBuffer);
        let out = "";
        let i = 0;
        // Skip BOM (EF BB BF) unless ignoreBOM is set.
        if (!this.ignoreBOM && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          i = 3;
        }
        while (i < bytes.length) {
          const b = bytes[i++];
          if (b < 0x80) { out += String.fromCharCode(b); }
          else if (b < 0xc0) { out += "�"; }
          else if (b < 0xe0) {
            const b2 = bytes[i++] ?? 0;
            out += String.fromCharCode(((b & 0x1f) << 6) | (b2 & 0x3f));
          } else if (b < 0xf0) {
            const b2 = bytes[i++] ?? 0, b3 = bytes[i++] ?? 0;
            out += String.fromCharCode(((b & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
          } else {
            const b2 = bytes[i++] ?? 0, b3 = bytes[i++] ?? 0, b4 = bytes[i++] ?? 0;
            const cp = ((b & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
            const hi = 0xd800 + ((cp - 0x10000) >> 10);
            const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
            out += String.fromCharCode(hi, lo);
          }
        }
        return out;
      }
    }
    (g as any).TextEncoder = CarbonTextEncoder;
    (g as any).TextDecoder = CarbonTextDecoder;
    if (g.window) {
      g.window.TextEncoder = CarbonTextEncoder;
      g.window.TextDecoder = CarbonTextDecoder;
    }
  }

  // ─── URL / URLSearchParams ──────────────────────────────────────────────
  // QuickJS doesn't ship these. AI-SDK, fetch wrappers, and most network
  // helpers depend on them at module init. Minimal but standards-aligned
  // parser — covers protocol/host/path/search/hash decomposition,
  // searchParams iteration + mutation, and toString re-assembly.
  if (typeof (g as any).URL === "undefined") {
    class CarbonURLSearchParams {
      private params: Array<[string, string]> = [];
      constructor(init?: string | Array<[string, string]> | Record<string, string> | CarbonURLSearchParams) {
        if (typeof init === "string") {
          let s = init;
          if (s.startsWith("?")) s = s.slice(1);
          if (s) {
            for (const pair of s.split("&")) {
              const eq = pair.indexOf("=");
              const k = eq < 0 ? decodeURIComponent(pair) : decodeURIComponent(pair.slice(0, eq));
              const v = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
              this.params.push([k, v]);
            }
          }
        } else if (Array.isArray(init)) {
          for (const [k, v] of init) this.params.push([String(k), String(v)]);
        } else if (init && typeof init === "object" && !(init instanceof CarbonURLSearchParams)) {
          for (const k of Object.keys(init)) this.params.push([k, String((init as any)[k])]);
        } else if (init instanceof CarbonURLSearchParams) {
          this.params = (init as any).params.slice();
        }
      }
      append(key: string, value: string) { this.params.push([key, String(value)]); }
      delete(key: string) { this.params = this.params.filter(([k]) => k !== key); }
      get(key: string): string | null { const e = this.params.find(([k]) => k === key); return e ? e[1] : null; }
      getAll(key: string): string[] { return this.params.filter(([k]) => k === key).map(([, v]) => v); }
      has(key: string): boolean { return this.params.some(([k]) => k === key); }
      set(key: string, value: string) { this.delete(key); this.append(key, value); }
      sort() { this.params.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); }
      keys() { return this.params.map(([k]) => k)[Symbol.iterator](); }
      values() { return this.params.map(([, v]) => v)[Symbol.iterator](); }
      entries() { return this.params[Symbol.iterator](); }
      forEach(cb: (v: string, k: string, p: CarbonURLSearchParams) => void) {
        for (const [k, v] of this.params) cb(v, k, this);
      }
      [Symbol.iterator]() { return this.entries(); }
      toString() {
        return this.params
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
      }
      get size() { return this.params.length; }
    }

    class CarbonURL {
      protocol = "";
      username = "";
      password = "";
      host = "";
      hostname = "";
      port = "";
      pathname = "/";
      search = "";
      hash = "";
      searchParams: CarbonURLSearchParams;

      constructor(url: string | CarbonURL, base?: string | CarbonURL) {
        this.searchParams = new CarbonURLSearchParams();
        let s = typeof url === "string" ? url : (url as any).toString();
        if (base !== undefined) {
          const b = typeof base === "string" ? base : (base as any).toString();
          // Crude join: if s is absolute, ignore base.
          if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(s)) {
            if (s.startsWith("/")) {
              const m = b.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/[^\/]+)/);
              s = m ? m[1] + s : s;
            } else {
              const trimmedBase = b.replace(/[^\/]*$/, "");
              s = trimmedBase + s;
            }
          }
        }
        this._parse(s);
        // Sync searchParams.
        const sp = new CarbonURLSearchParams(this.search);
        this.searchParams = new Proxy(sp, {
          get: (t, p) => (t as any)[p],
          set: (t, p, v) => { (t as any)[p] = v; this._syncSearch(t); return true; },
        }) as any;
        // Wire mutations through proxy too — calls that change params
        // need to update this.search. We override via prototype on
        // the instance directly for the methods that mutate.
        const mutating = ["append", "delete", "set", "sort"];
        for (const m of mutating) {
          const orig = (sp as any)[m].bind(sp);
          (this.searchParams as any)[m] = (...args: any[]) => {
            const r = orig(...args);
            this._syncSearch(sp);
            return r;
          };
        }
      }

      private _parse(s: string) {
        // protocol:
        const protoMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):/);
        if (!protoMatch) throw new TypeError(`Invalid URL: ${s}`);
        this.protocol = protoMatch[1].toLowerCase() + ":";
        let rest = s.slice(protoMatch[0].length);
        if (rest.startsWith("//")) {
          rest = rest.slice(2);
          const slash = rest.search(/[/?#]/);
          const auth = slash < 0 ? rest : rest.slice(0, slash);
          rest = slash < 0 ? "" : rest.slice(slash);
          // userinfo@host:port
          const at = auth.lastIndexOf("@");
          let hostPort = auth;
          if (at >= 0) {
            const userinfo = auth.slice(0, at);
            const colon = userinfo.indexOf(":");
            this.username = colon < 0 ? userinfo : userinfo.slice(0, colon);
            this.password = colon < 0 ? "" : userinfo.slice(colon + 1);
            hostPort = auth.slice(at + 1);
          }
          const colonPort = hostPort.lastIndexOf(":");
          if (colonPort > 0 && /^\d+$/.test(hostPort.slice(colonPort + 1))) {
            this.hostname = hostPort.slice(0, colonPort);
            this.port = hostPort.slice(colonPort + 1);
            this.host = hostPort;
          } else {
            this.hostname = hostPort;
            this.host = hostPort;
          }
        }
        const hashIdx = rest.indexOf("#");
        if (hashIdx >= 0) {
          this.hash = rest.slice(hashIdx);
          rest = rest.slice(0, hashIdx);
        }
        const qIdx = rest.indexOf("?");
        if (qIdx >= 0) {
          this.search = rest.slice(qIdx);
          rest = rest.slice(0, qIdx);
        }
        this.pathname = rest || "/";
      }

      private _syncSearch(sp: CarbonURLSearchParams) {
        const s = sp.toString();
        this.search = s ? "?" + s : "";
      }

      get href(): string { return this.toString(); }
      set href(value: string) { this._parse(value); }
      get origin(): string {
        if (this.protocol === "file:") return "null";
        return `${this.protocol}//${this.host}`;
      }
      toString(): string {
        const auth = this.username
          ? `${this.username}${this.password ? ":" + this.password : ""}@`
          : "";
        return `${this.protocol}//${auth}${this.host}${this.pathname}${this.search}${this.hash}`;
      }
      toJSON(): string { return this.toString(); }

      static createObjectURL(_obj: unknown): string { return "blob:carbon-mini/0"; }
      static revokeObjectURL(_url: string): void {}
      static canParse(url: string, base?: string): boolean {
        try { new CarbonURL(url, base); return true; } catch { return false; }
      }
    }

    (g as any).URL = CarbonURL;
    (g as any).URLSearchParams = CarbonURLSearchParams;
    if (g.window) {
      g.window.URL = CarbonURL;
      g.window.URLSearchParams = CarbonURLSearchParams;
    }
  }
  // Expose on window too for libraries that reach through it.
  if (g.window) {
    g.window.ReadableStream = CarbonReadableStream;
    g.window.WritableStream = CarbonWritableStream;
    g.window.TransformStream = CarbonTransformStream;
  }

  // Common text decoders/encoders that often pair with streams. QuickJS
  // provides TextEncoder/TextDecoder natively in newer builds; only
  // install fallbacks if missing.
  if (typeof (g as any).TextDecoderStream === "undefined") {
    class CarbonTextDecoderStream extends CarbonTransformStream<Uint8Array, string> {
      constructor(label = "utf-8", _options?: any) {
        const decoder = new (g as any).TextDecoder(label);
        super({
          transform(chunk, c) { c.enqueue(decoder.decode(chunk, { stream: true })); },
          flush(c) { c.enqueue(decoder.decode()); },
        });
      }
    }
    (g as any).TextDecoderStream = CarbonTextDecoderStream;
  }
  if (typeof (g as any).TextEncoderStream === "undefined") {
    class CarbonTextEncoderStream extends CarbonTransformStream<string, Uint8Array> {
      constructor() {
        const encoder = new (g as any).TextEncoder();
        super({
          transform(chunk, c) { c.enqueue(encoder.encode(chunk)); },
        });
      }
    }
    (g as any).TextEncoderStream = CarbonTextEncoderStream;
  }
}

export {};
