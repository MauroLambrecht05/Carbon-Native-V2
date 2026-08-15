// App-level events: the ones that arrive at the window rather than at a node.
//
// Separate from scene/events.ts, which routes what the hit-test found to the
// handler on a particular node. Nothing here is addressed to a node — a theme
// change, a window focus, a chord shortcut and an OS file drop are all facts
// about the application, so they fan out to listener sets instead.

// ─── Window + system theme + context menu events ────────────────────────

export const themeListeners = new Set<(theme: "light" | "dark") => void>();
(globalThis as any).__cm_dispatch_theme_changed = (theme: string) => {
  const t = theme === "dark" ? "dark" : "light";
  for (const cb of themeListeners) {
    try { cb(t); } catch (_) {}
  }
};
export function onThemeChange(cb: (theme: "light" | "dark") => void): () => void {
  themeListeners.add(cb);
  return () => { themeListeners.delete(cb); };
}

export const focusListeners = new Set<(focused: boolean) => void>();
(globalThis as any).__cm_dispatch_window_focus = (focused: boolean) => {
  for (const cb of focusListeners) {
    try { cb(focused); } catch (_) {}
  }
};
export function onWindowFocus(cb: (focused: boolean) => void): () => void {
  focusListeners.add(cb);
  return () => { focusListeners.delete(cb); };
}

export interface ContextMenuEvent {
  /** Hit-tested node id at the cursor, or null if no clickable hit. */
  id: number | null;
  /** Window-space x/y of the right-click in CSS pixels. */
  x: number;
  y: number;
}
export const contextMenuListeners = new Set<(e: ContextMenuEvent) => void>();
(globalThis as any).__cm_dispatch_context_menu = (id: number | null, x: number, y: number) => {
  const evt: ContextMenuEvent = { id, x, y };
  for (const cb of contextMenuListeners) {
    try { cb(evt); } catch (_) {}
  }
};
export function onContextMenu(cb: (e: ContextMenuEvent) => void): () => void {
  contextMenuListeners.add(cb);
  return () => { contextMenuListeners.delete(cb); };
}

// ─── App-level keydown ───────────────────────────────────────────────────
//
// Apps register listeners via `onKeyDown(cb)` and receive every key
// press (whether or not an input is focused). The Rust side still
// routes the same event to the focused input/textarea afterwards, so
// shortcut handlers don't have to compete for ownership — they're
// purely additive. Typical use: cmd/ctrl chord shortcuts, escape to
// close modals, '?' to open help.

export interface CarbonKeyEvent {
  /** Logical key name. Letters/digits arrive lowercase ("a", "1");
   *  named keys use the W3C-ish label ("Enter", "Escape", "ArrowLeft",
   *  "F1"…). For unknown keys the Debug-format of tao's enum is used. */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Super / Command / Windows key. */
  meta: boolean;
}

export const keydownListeners = new Set<(e: CarbonKeyEvent) => void>();

(globalThis as any).__cm_dispatch_keydown = (
  key: string,
  ctrl: boolean,
  shift: boolean,
  alt: boolean,
  meta: boolean,
) => {
  const evt: CarbonKeyEvent = { key, ctrl, shift, alt, meta };
  for (const cb of keydownListeners) {
    try { cb(evt); } catch (_) {}
  }
};

/** Register a global keydown listener. Returns an unsubscribe. */
export function onKeyDown(cb: (e: CarbonKeyEvent) => void): () => void {
  keydownListeners.add(cb);
  return () => { keydownListeners.delete(cb); };
}

// ─── OS file drag-and-drop ───────────────────────────────────────────────
//
// The Rust runtime forwards `WindowEvent::HoveredFile` / `DroppedFile`
// / `HoveredFileCancelled` via `__cm_dispatch_file_drag(kind, path)`.
// We collect registered listeners and fan out, mimicking the
// browser's `addEventListener('drop', ...)` registration model.
//
// `kind` is `"enter" | "leave" | "drop"`. `path` is the absolute file
// path on enter/drop, and null on leave. Apps that want a "session
// complete" signal can debounce inside the listener — tao fires one
// event per file, all in the same event-loop tick.
export interface FileDragEvent {
  kind: "enter" | "leave" | "drop";
  path: string | null;
}

export const fileDragListeners = new Set<(e: FileDragEvent) => void>();

(globalThis as any).__cm_dispatch_file_drag = (kind: string, path: string | null) => {
  const evt: FileDragEvent = {
    kind: kind as FileDragEvent["kind"],
    path,
  };
  for (const cb of fileDragListeners) {
    try { cb(evt); } catch (_) {}
  }
};

/**
 * Register a listener for OS-level file drag-and-drop events fired
 * onto the window. Returns an unsubscribe function.
 *
 * ```ts
 * import { onFileDrag } from "@carbon/mini-solid";
 * const off = onFileDrag(e => {
 *   if (e.kind === "drop") console.log("dropped:", e.path);
 * });
 * // later: off();
 * ```
 */
export function onFileDrag(cb: (e: FileDragEvent) => void): () => void {
  fileDragListeners.add(cb);
  return () => { fileDragListeners.delete(cb); };
}
