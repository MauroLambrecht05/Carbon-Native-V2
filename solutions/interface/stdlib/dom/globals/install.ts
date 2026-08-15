// install — sets globalThis.{document, window, ...} so DOM-targeting
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
//
// ── WHAT IS AND IS NOT IN THIS FILE ─────────────────────────────────────────
// This owns what genuinely needs `document` and `window` in one closure: the
// document, the window object built around it, and the two bridges that turn
// runtime events (resize, keydown) into DOM ones.
//
// Everything else was a self-contained block inside the same 725-line `if`,
// touching nothing but `globalThis`. Those are named installers next door —
// storage, observers, the canvas constructors, the FontFaceSet stub — called
// at the bottom in the order they always ran in. Web Streams and URL sit
// further out still, in ../shims/streams.ts, because they never depended on a
// document at all.

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
} from "../shims/node.ts";
import { keyToCode, keyToKeyCode } from "../shims/keyboard.ts";
import "../shims/streams.ts";
import { installCanvasGlobals } from "./canvas.ts";
import { installFontFaceSet } from "./fonts.ts";
import { installObservers } from "./observers.ts";
import { installStorage } from "./storage.ts";

declare const __cm_request_paint: () => void;
declare const __cm_window_inner_width: (() => number) | undefined;
declare const __cm_window_inner_height: (() => number) | undefined;

const g = globalThis as any;



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


  installStorage(g);
  installObservers(g);
  installCanvasGlobals(g);
  installFontFaceSet(doc);

  // Repaint after install so anything painted during init flushes.
  if (typeof __cm_request_paint === "function") __cm_request_paint();
}
