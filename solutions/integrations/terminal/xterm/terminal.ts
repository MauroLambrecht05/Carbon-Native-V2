// xterm-compatible Terminal class on top of the carbon-mini scene graph.
//
// Difference vs upstream xterm.js:
//   - No <canvas>. The grid is painted by emitting one scene-graph
//     `<div>` per cell with the cell's character + colors as inline
//     style. That's heavier per-cell than xterm.js's canvas blits, but
//     it works in the no-webview runtime without dragging in a full
//     Canvas2D implementation.
//   - `WebglAddon` is a no-op. `WebLinksAddon` is rendered as plain text
//     with click handlers (the addon installs them itself).
//
// The public API matches what terax-ai and the broader xterm ecosystem
// call: `new Terminal(opts)`, `term.open(host)`, `term.write(data)`,
// `term.onData(cb)`, `term.loadAddon(addon)`, `term.cols`, `term.rows`,
// `term.buffer`, etc.

import { AnsiParser } from "./ansi";
import { Emitter } from "./events";
import { BufferNamespace, Grid } from "./grid";
import type {
  IBufferNamespace,
  IDisposable,
  IMarker,
  ITerminal,
  ITerminalAddon,
  ITerminalOptions,
  ITheme,
} from "./types";

const DEFAULT_THEME: Required<ITheme> = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  selectionInactiveBackground: "#3a3d41",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

function resolveColor(theme: Required<ITheme>, code: number, isFg: boolean): string {
  if (code === -1) return isFg ? theme.foreground : theme.background;
  // Truecolor (24-bit) — high byte is alpha sentinel.
  if (code > 0xffffff) {
    const r = (code >> 16) & 0xff;
    const g = (code >> 8) & 0xff;
    const b = code & 0xff;
    return `rgb(${r}, ${g}, ${b})`;
  }
  // Palette 0..15
  const palette = [
    theme.black, theme.red, theme.green, theme.yellow,
    theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ];
  if (code >= 0 && code <= 15) return palette[code];
  // 256-color cube + greyscale — collapse to greyscale approximation.
  if (code >= 16 && code <= 231) {
    const c = code - 16;
    const r = Math.floor(c / 36) * 51;
    const g = Math.floor((c % 36) / 6) * 51;
    const b = (c % 6) * 51;
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (code >= 232 && code <= 255) {
    const v = 8 + (code - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  return isFg ? theme.foreground : theme.background;
}

export class Terminal implements ITerminal {
  readonly options: ITerminalOptions;
  private grid: Grid;
  private ansi: AnsiParser;
  private theme: Required<ITheme>;
  private bufferNs: BufferNamespace;

  // Mounted host + per-cell DOM nodes for the scene graph painter.
  private host: HTMLElement | undefined;
  private viewportEl: HTMLElement | undefined;
  private cursorEl: HTMLElement | undefined;
  private cellEls: HTMLElement[][] = [];
  private pendingRender = false;

  // Event emitters
  private dataEmitter = new Emitter<string>();
  private binaryEmitter = new Emitter<string>();
  private keyEmitter = new Emitter<{ key: string; domEvent: KeyboardEvent }>();
  private resizeEmitter = new Emitter<{ cols: number; rows: number }>();
  private titleEmitter = new Emitter<string>();
  private cursorMoveEmitter = new Emitter<void>();
  private selectionEmitter = new Emitter<void>();
  private writeParsedEmitter = new Emitter<void>();
  private renderEmitter = new Emitter<{ start: number; end: number }>();

  private customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  private customWheelHandler: ((e: WheelEvent) => boolean) | null = null;
  private addons: ITerminalAddon[] = [];
  private disposed = false;

  constructor(options: ITerminalOptions = {}) {
    this.options = options;
    this.theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const scrollback = options.scrollback ?? 1000;
    this.grid = new Grid(cols, rows, scrollback);
    this.ansi = new AnsiParser(this.grid, {
      onTitleChange: (t) => this.titleEmitter.fire(t),
    });
    this.bufferNs = new BufferNamespace(this.grid);
  }

  get cols(): number { return this.grid.cols; }
  get rows(): number { return this.grid.rows; }
  get element(): HTMLElement | undefined { return this.host; }
  get textarea(): HTMLTextAreaElement | undefined { return undefined; }
  get buffer(): IBufferNamespace { return this.bufferNs; }

  /** xterm.js `IParser` surface. Apps use `term.parser.registerOscHandler`
   *  for shell integration (OSC 7 cwd, OSC 133 prompt marks). We delegate
   *  to the live AnsiParser via `this.ansi` (recreated on reset, so the
   *  facade resolves it lazily). CSI/DCS/ESC handler registration is
   *  accepted but inert — nothing in the supported app set relies on it. */
  get parser(): {
    registerOscHandler(ident: number, handler: (data: string) => boolean): { dispose(): void };
    registerCsiHandler(): { dispose(): void };
    registerDcsHandler(): { dispose(): void };
    registerEscHandler(): { dispose(): void };
  } {
    const self = this;
    const inert = { dispose() {} };
    return {
      registerOscHandler: (ident, handler) =>
        self.ansi.registerOscHandler(ident, handler),
      registerCsiHandler: () => inert,
      registerDcsHandler: () => inert,
      registerEscHandler: () => inert,
    };
  }

  open(parent: HTMLElement): void {
    this.host = parent;
    // Build the viewport: a flex-column of N rows, each row a flex-row of
    // M cells. Each cell is its own scene-graph <div> so SGR colors map
    // to inline background/color styles. Cursor sits on top as an
    // absolutely-positioned bar.
    const doc = (parent as unknown as { ownerDocument?: Document }).ownerDocument
      ?? (globalThis as unknown as { document: Document }).document;
    const viewport = doc.createElement("div");
    viewport.style.cssText = [
      `font-family: ${this.options.fontFamily ?? "monospace"}`,
      `font-size: ${this.options.fontSize ?? 14}px`,
      `line-height: ${this.options.lineHeight ?? 1.2}`,
      "white-space: pre",
      "user-select: text",
      "position: relative",
      "width: 100%",
      "height: 100%",
      "overflow: hidden",
      `background: ${this.theme.background}`,
      `color: ${this.theme.foreground}`,
    ].join("; ");
    parent.appendChild(viewport);
    this.viewportEl = viewport;

    // Pre-allocate per-row containers + cell elements. We update text
    // content in place on each render rather than rebuilding the tree,
    // which makes scrolling cheap.
    const fsz = this.options.fontSize ?? 14;
    const rowH = fsz * (this.options.lineHeight ?? 1.2);
    const colW = fsz * 0.6;
    this.cellEls = [];
    for (let y = 0; y < this.rows; y++) {
      const rowEl = doc.createElement("div");
      rowEl.style.cssText = `display: flex; flex-direction: row; height: ${rowH}px; flex-shrink: 0;`;
      viewport.appendChild(rowEl);
      const cells: HTMLElement[] = [];
      for (let x = 0; x < this.cols; x++) {
        const cellEl = doc.createElement("span");
        cellEl.style.cssText = `display: inline-block; width: ${colW}px; min-width: ${colW}px; height: ${rowH}px; overflow: hidden;`;
        cellEl.textContent = " ";
        rowEl.appendChild(cellEl);
        cells.push(cellEl);
      }
      this.cellEls.push(cells);
    }

    // Cursor — overlayed on top, kept positioned by render().
    const cursor = doc.createElement("div");
    cursor.style.cssText = [
      "position: absolute",
      "top: 0", "left: 0",
      `width: 0.6em`,
      "height: 1.2em",
      `background: ${this.theme.cursor}`,
      "opacity: 0.5",
      "pointer-events: none",
    ].join("; ");
    viewport.appendChild(cursor);
    this.cursorEl = cursor;

    this.scheduleRender();
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return;
    const text = typeof data === "string" ? data : bytesToString(data);
    this.ansi.feed(text);
    this.writeParsedEmitter.fire();
    this.scheduleRender();
    if (callback) {
      // Match xterm.js: callback fires after the parser drains (sync here).
      try { callback(); } catch (e) { console.error("[xterm-shim] write cb:", e); }
    }
  }

  writeln(data: string | Uint8Array, callback?: () => void): void {
    this.write(data);
    this.write("\r\n", callback);
  }

  clear(): void {
    this.grid.eraseDisplay(2);
    this.grid.cursorX = 0;
    this.grid.cursorY = 0;
    this.scheduleRender();
  }

  reset(): void {
    const cols = this.grid.cols, rows = this.grid.rows, sb = this.grid.scrollback;
    this.grid = new Grid(cols, rows, sb);
    this.ansi = new AnsiParser(this.grid, { onTitleChange: (t) => this.titleEmitter.fire(t) });
    this.bufferNs = new BufferNamespace(this.grid);
    this.scheduleRender();
  }

  resize(cols: number, rows: number): void {
    if (cols === this.grid.cols && rows === this.grid.rows) return;
    this.grid.resize(cols, rows);
    this.rebuildDom();
    this.resizeEmitter.fire({ cols, rows });
    this.scheduleRender();
  }

  private rebuildDom(): void {
    if (!this.viewportEl) return;
    const doc = (this.viewportEl as unknown as { ownerDocument?: Document }).ownerDocument
      ?? (globalThis as unknown as { document: Document }).document;
    // Wipe and reallocate. Keeping the cursor element separate.
    while (this.viewportEl.firstChild) this.viewportEl.removeChild(this.viewportEl.firstChild);
    const fsz = this.options.fontSize ?? 14;
    const rowH = fsz * (this.options.lineHeight ?? 1.2);
    const colW = fsz * 0.6;
    this.cellEls = [];
    for (let y = 0; y < this.rows; y++) {
      const rowEl = doc.createElement("div");
      rowEl.style.cssText = `display: flex; flex-direction: row; height: ${rowH}px; flex-shrink: 0;`;
      this.viewportEl.appendChild(rowEl);
      const cells: HTMLElement[] = [];
      for (let x = 0; x < this.cols; x++) {
        const cellEl = doc.createElement("span");
        cellEl.style.cssText = `display: inline-block; width: ${colW}px; min-width: ${colW}px; height: ${rowH}px; overflow: hidden;`;
        cellEl.textContent = " ";
        rowEl.appendChild(cellEl);
        cells.push(cellEl);
      }
      this.cellEls.push(cells);
    }
    if (this.cursorEl) this.viewportEl.appendChild(this.cursorEl);
  }

  focus(): void { /* no-op — focus is handled by the surrounding app */ }
  blur(): void {}
  hasSelection(): boolean { return false; }
  getSelection(): string { return ""; }
  clearSelection(): void {}
  selectAll(): void {}
  scrollLines(_amount: number): void {}
  scrollPages(_amount: number): void {}
  scrollToTop(): void {}
  scrollToBottom(): void {}
  scrollToLine(_line: number): void {}

  loadAddon(addon: ITerminalAddon): void {
    this.addons.push(addon);
    try { addon.activate(this); }
    catch (e) { console.error("[xterm-shim] addon.activate:", e); }
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.customKeyHandler = handler;
  }

  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean): void {
    this.customWheelHandler = handler;
  }

  /** Called by external input pipelines (e.g. carbon-mini's keydown
   *  bridge or app code that forwards keypresses to the terminal).
   *  Translates the key into the corresponding terminal byte sequence
   *  and fires `onData`. */
  feedKey(e: KeyboardEvent): void {
    if (this.customKeyHandler && this.customKeyHandler(e) === false) return;
    const data = keyEventToBytes(e);
    if (data) {
      this.dataEmitter.fire(data);
      this.keyEmitter.fire({ key: e.key, domEvent: e });
    }
  }

  onData(cb: (data: string) => void): IDisposable { return this.dataEmitter.event(cb); }
  onBinary(cb: (data: string) => void): IDisposable { return this.binaryEmitter.event(cb); }
  onKey(cb: (e: { key: string; domEvent: KeyboardEvent }) => void): IDisposable { return this.keyEmitter.event(cb); }
  onResize(cb: (e: { cols: number; rows: number }) => void): IDisposable { return this.resizeEmitter.event(cb); }
  onTitleChange(cb: (title: string) => void): IDisposable { return this.titleEmitter.event(cb); }
  onCursorMove(cb: () => void): IDisposable { return this.cursorMoveEmitter.event(cb); }
  onSelectionChange(cb: () => void): IDisposable { return this.selectionEmitter.event(cb); }
  onWriteParsed(cb: () => void): IDisposable { return this.writeParsedEmitter.event(cb); }
  onRender(cb: (e: { start: number; end: number }) => void): IDisposable { return this.renderEmitter.event(cb); }

  registerMarker(_cursorYOffset?: number): IMarker {
    const line = this.grid.lines.length - this.grid.rows + this.grid.cursorY;
    let disposed = false;
    return {
      id: line,
      line,
      get isDisposed() { return disposed; },
      dispose() { disposed = true; },
    };
  }

  refresh(_start: number, _end: number): void { this.scheduleRender(); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const a of this.addons) {
      try { a.dispose(); } catch (e) { console.error("[xterm-shim] addon.dispose:", e); }
    }
    this.addons = [];
    this.dataEmitter.clear();
    this.binaryEmitter.clear();
    this.keyEmitter.clear();
    this.resizeEmitter.clear();
    this.titleEmitter.clear();
    this.cursorMoveEmitter.clear();
    this.selectionEmitter.clear();
    this.writeParsedEmitter.clear();
    this.renderEmitter.clear();
    if (this.viewportEl?.parentNode) {
      this.viewportEl.parentNode.removeChild(this.viewportEl);
    }
    this.viewportEl = undefined;
    this.cursorEl = undefined;
    this.cellEls = [];
  }

  // ─── Render loop ─────────────────────────────────────────────────────

  private scheduleRender(): void {
    if (this.pendingRender || this.disposed) return;
    this.pendingRender = true;
    const raf = (globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => void })
      .requestAnimationFrame;
    if (typeof raf === "function") raf(() => this.flushRender());
    else Promise.resolve().then(() => this.flushRender());
  }

  private flushRender(): void {
    this.pendingRender = false;
    if (this.disposed || !this.viewportEl) return;
    // Fixed cell box in PX. carbon-mini doesn't resolve `em`, so the old
    // `min-width: 0.6em` was dropped and cells collapsed to the glyph
    // advance of a space — squishing the grid and overlapping text. Pin an
    // explicit monospace cell so columns line up.
    const fontSize = this.options.fontSize ?? 14;
    const cellW = fontSize * 0.6;
    const cellH = fontSize * (this.options.lineHeight ?? 1.2);
    // Repaint visible rows. cellEls is row-major over [0..rows).
    for (let y = 0; y < this.rows; y++) {
      const row = this.grid.rowAt(y);
      const cellRow = this.cellEls[y];
      if (!cellRow) continue;
      for (let x = 0; x < this.cols; x++) {
        const cell = row.cells[x];
        const el = cellRow[x];
        if (!el || !cell) continue;
        const txt = cell.ch || " ";
        if (el.textContent !== txt) el.textContent = txt;
        const fg = resolveColor(this.theme, cell.attrs.fg, true);
        const bg = resolveColor(this.theme, cell.attrs.bg, false);
        const inverse = cell.attrs.inverse;
        const fgFinal = inverse ? bg : fg;
        const bgFinal = inverse ? fg : (cell.attrs.bg === -1 ? "" : bg);
        // Inline styles. We diff manually to avoid layout thrash from
        // unconditionally writing the cssText on every cell every frame.
        const want = [
          "display: inline-block",
          `width: ${cellW}px`,
          `min-width: ${cellW}px`,
          `height: ${cellH}px`,
          "overflow: hidden",
          `color: ${fgFinal}`,
          bgFinal ? `background: ${bgFinal}` : "",
          cell.attrs.bold ? "font-weight: bold" : "",
          cell.attrs.italic ? "font-style: italic" : "",
          cell.attrs.underline ? "text-decoration: underline" : "",
          cell.attrs.strike ? "text-decoration: line-through" : "",
          cell.attrs.dim ? "opacity: 0.6" : "",
        ].filter(Boolean).join("; ");
        if (el.style.cssText !== want) el.style.cssText = want;
      }
    }
    // Cursor — position via CSS transform (cheap, no reflow).
    if (this.cursorEl) {
      const fontSize = (this.options.fontSize ?? 14);
      const cellW = fontSize * 0.6;
      const cellH = fontSize * (this.options.lineHeight ?? 1.2);
      this.cursorEl.style.left = `${this.grid.cursorX * cellW}px`;
      this.cursorEl.style.top = `${this.grid.cursorY * cellH}px`;
    }
    this.renderEmitter.fire({ start: 0, end: this.rows - 1 });
  }
}

function bytesToString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Translate a DOM KeyboardEvent into the byte sequence a PTY-attached
 *  shell expects. Mirrors xterm.js's default key handler for the common
 *  cases — printable keys, arrow keys, Backspace, Enter, Tab, Esc, plus
 *  Ctrl+letter. Modified non-printable combinations fall through to the
 *  customKeyHandler. */
function keyEventToBytes(e: KeyboardEvent): string | null {
  const k = e.key;
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (k.length === 1) {
      const c = k.toLowerCase().charCodeAt(0);
      if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60); // Ctrl+a..z
    }
    if (k === " ") return "\x00";
    if (k === "[") return "\x1b";
    if (k === "\\") return "\x1c";
    if (k === "]") return "\x1d";
  }
  switch (k) {
    case "Enter": return "\r";
    case "Backspace": return "\x7f";
    case "Tab": return e.shiftKey ? "\x1b[Z" : "\t";
    case "Escape": return "\x1b";
    case "ArrowUp": return "\x1b[A";
    case "ArrowDown": return "\x1b[B";
    case "ArrowRight": return "\x1b[C";
    case "ArrowLeft": return "\x1b[D";
    case "Home": return "\x1b[H";
    case "End": return "\x1b[F";
    case "PageUp": return "\x1b[5~";
    case "PageDown": return "\x1b[6~";
    case "Delete": return "\x1b[3~";
    case "Insert": return "\x1b[2~";
    case "F1": return "\x1bOP";
    case "F2": return "\x1bOQ";
    case "F3": return "\x1bOR";
    case "F4": return "\x1bOS";
  }
  if (k.length === 1 && !e.ctrlKey && !e.metaKey) return k;
  return null;
}
