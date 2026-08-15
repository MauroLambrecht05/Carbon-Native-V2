// Window control + multi-window. `getCurrentWindow()` exposes the
// methods on the window the calling code is mounted in; `openWindow()`
// spawns a second native window (waiting on §4.13 multi-window in the
// runtime — until that lands, `openWindow` throws an explanatory error).
//
//   import { getCurrentWindow, openWindow } from "@carbon/api/window";
//   const w = getCurrentWindow();
//   await w.minimize();
//   await w.onResize(() => console.log(w.innerSize()));
//   await openWindow({ entry: "settings", label: "settings", title: "Settings" });

import "../host/imports";

export interface Size {
  width: number;
  height: number;
}

export interface OpenWindowOpts {
  /** Stable identifier the new window uses to know "which page am I?"
   *  Read back from inside the new window via `getCurrentWindow().label`
   *  (or directly via `__cm_window_label()`). Common values:
   *  "settings", "preferences", "about". */
  label: string;
  /** Initial title bar text. */
  title?: string;
  /** Initial inner size in logical pixels. */
  width?: number;
  height?: number;
  /** Hide the OS window decorations (custom title bar). */
  decorated?: boolean;
  /** Allow the user to resize. Default true. */
  resizable?: boolean;
  /** Free-form payload forwarded to the new window. Read via
   *  `getCurrentWindow().opts` from inside that window. */
  query?: Record<string, unknown>;
}

export interface CarbonWindow {
  /** Identity passed via `--window-label` at process startup.
   *  "main" for the primary window. */
  readonly label: string;
  /** Free-form opts the parent passed via `openWindow({label, ...opts})`.
   *  null on the main window, the parsed JSON otherwise. */
  readonly opts: Record<string, unknown> | null;

  /** Show the window (does nothing if already visible). */
  show(): Promise<void>;
  hide(): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  unmaximize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  focus(): Promise<void>;
  setTitle(title: string): Promise<void>;
  setFullscreen(on: boolean): Promise<void>;
  /** Begin a system drag for borderless windows. Call from a mousedown
   *  handler on a custom title bar. */
  startDrag(): Promise<void>;

  isMaximized(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
  isFocused(): Promise<boolean>;
  innerSize(): Size;
  devicePixelRatio(): number;

  /** Subscribe to resize events. Returns an unlisten function. */
  onResize(cb: (size: Size) => void): () => void;
  /** Alias for `onResize` matching the Tauri callback name. */
  onResized(cb: (event: { payload: Size }) => void): Promise<() => void>;
  /** Subscribe to focus/blur events. */
  onFocus(cb: (focused: boolean) => void): () => void;
  /** Per-window event bus. `emit(channel, payload)` from another window
   *  reaches this one via the engine's cross-window broadcast (§4.13). */
  listen<T>(channel: string, cb: (event: { event: string; payload: T }) => void): Promise<() => void>;
}

let cachedCurrent: CarbonWindow | null = null;

export function getCurrentWindow(): CarbonWindow {
  if (cachedCurrent) return cachedCurrent;
  cachedCurrent = createWindowProxy();
  return cachedCurrent;
}

function createWindowProxy(): CarbonWindow {
  let parsedOpts: Record<string, unknown> | null = null;
  try {
    const j = __cm_window_opts_json();
    if (j && j !== "{}") parsedOpts = JSON.parse(j) as Record<string, unknown>;
  } catch { /* malformed opts — treat as none */ }
  return {
    get label() { return __cm_window_label(); },
    get opts() { return parsedOpts; },
    async show() { __cm_window_show(); },
    async hide() { __cm_window_hide(); },
    async minimize() { __cm_window_minimize(); },
    async maximize() { __cm_window_maximize(); },
    async unmaximize() { __cm_window_unmaximize(); },
    async toggleMaximize() { __cm_window_toggle_maximize(); },
    async close() { __cm_window_close(); },
    async focus() { __cm_window_focus(); },
    async setTitle(t) { __cm_window_set_title(t); },
    async setFullscreen(on) { __cm_window_set_fullscreen(on); },
    async startDrag() { __cm_window_start_drag(); },

    async isMaximized() { return __cm_window_is_maximized(); },
    async isMinimized() { return __cm_window_is_minimized(); },
    async isFocused() { return __cm_window_is_focused(); },
    innerSize() {
      return {
        width: __cm_window_inner_width(),
        height: __cm_window_inner_height(),
      };
    },
    devicePixelRatio() {
      return __cm_window_device_pixel_ratio();
    },

    onResize(cb) {
      const g = globalThis as unknown as {
        __cm_window_dispatch_resize?: () => void;
      };
      const prev = g.__cm_window_dispatch_resize;
      g.__cm_window_dispatch_resize = () => {
        try { prev?.(); } catch { /* keep going */ }
        try { cb({ width: __cm_window_inner_width(), height: __cm_window_inner_height() }); }
        catch (e) { console.error("[window.onResize]", e); }
      };
      // Unlisten: restore the previous chain (best effort — if other
      // subscribers chained after this one, their wrappers will keep
      // calling our callback. For most cases there's a single listener.)
      return () => {
        if (g.__cm_window_dispatch_resize) g.__cm_window_dispatch_resize = prev;
      };
    },

    async onResized(cb) {
      const un = this.onResize((size) => cb({ payload: size }));
      return un;
    },

    onFocus(cb) {
      const g = globalThis as unknown as {
        __cm_dispatch_window_focus?: (focused: boolean) => void;
      };
      const prev = g.__cm_dispatch_window_focus;
      g.__cm_dispatch_window_focus = (focused: boolean) => {
        try { prev?.(focused); } catch { /* keep going */ }
        try { cb(focused); } catch (e) { console.error("[window.onFocus]", e); }
      };
      return () => {
        if (g.__cm_dispatch_window_focus) g.__cm_dispatch_window_focus = prev;
      };
    },

    async listen(channel, cb) {
      const { listen: ev } = await import("../bridge/event.ts");
      return ev(channel, cb);
    },
  };
}

/**
 * Open a new native window. Implementation is process-per-window v1:
 * the engine spawns a child `carbon-mini` process running the same
 * bundle, passing `--window-label <label>` so the bundle can detect
 * which page it should render. Everything other than `label` is
 * forwarded as JSON via `--window-opts` and accessible from inside the
 * new window as `getCurrentWindow().opts`.
 *
 *   import { openWindow, getCurrentWindow } from "@carbon/api/window";
 *
 *   // From the main window (root bundle entry):
 *   await openWindow({ label: "settings", title: "Settings", width: 720, height: 560,
 *                      query: { section: "general" } });
 *
 *   // Inside the settings child process (same bundle):
 *   const me = getCurrentWindow();
 *   if (me.label === "settings") {
 *     const section = (me.opts?.query as { section?: string })?.section ?? "general";
 *     render(<SettingsApp section={section} />);
 *   }
 *
 * Returns a thin remote handle — the child process owns its own state,
 * so the few methods that meaningfully cross the process boundary
 * (close / focus) are stubbed to throw. Use cross-window events
 * (@carbon/api/event, once IPC lands) to coordinate.
 */
export async function openWindow(opts: OpenWindowOpts): Promise<CarbonWindow> {
  const { label, ...rest } = opts;
  __cm_window_open(label, JSON.stringify(rest));
  // Return a placeholder handle. The child window owns its own state;
  // controlling it from the parent requires the cross-window event bus.
  return remoteWindowHandle(label, rest);
}

function remoteWindowHandle(label: string, opts: Record<string, unknown>): CarbonWindow {
  const notImplemented = (op: string) => () => {
    throw new Error(
      `@carbon/api/window: ${op}() on a remote window requires cross-window IPC — ` +
      `not yet implemented. The child window owns its own state; call this from ` +
      `inside that window (via getCurrentWindow()) instead.`,
    );
  };
  return {
    label,
    opts,
    show: notImplemented("show"),
    hide: notImplemented("hide"),
    minimize: notImplemented("minimize"),
    maximize: notImplemented("maximize"),
    unmaximize: notImplemented("unmaximize"),
    toggleMaximize: notImplemented("toggleMaximize"),
    close: notImplemented("close"),
    focus: notImplemented("focus"),
    setTitle: notImplemented("setTitle"),
    setFullscreen: notImplemented("setFullscreen"),
    startDrag: notImplemented("startDrag"),
    isMaximized: notImplemented("isMaximized") as () => Promise<boolean>,
    isMinimized: notImplemented("isMinimized") as () => Promise<boolean>,
    isFocused: notImplemented("isFocused") as () => Promise<boolean>,
    innerSize: () => ({
      width: (opts.width as number) ?? 0,
      height: (opts.height as number) ?? 0,
    }),
    devicePixelRatio: () => 1,
    onResize: () => () => {},
    onResized: async () => () => {},
    onFocus: () => () => {},
    listen: async () => () => {},
  };
}
