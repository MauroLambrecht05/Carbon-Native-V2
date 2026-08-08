// Cell grid for the terminal. Stores one Cell per (row, col) plus a
// scrollback ring. Mirrors xterm.js's logical model closely enough that
// SearchAddon / SerializeAddon round-trip correctly — `translateToString`
// just joins cell `.ch` values per line.

import type { IBuffer, IBufferCell, IBufferLine, IBufferNamespace, IDisposable } from "./types";
import { Emitter } from "./events";

/** Logical cell attributes — packed enough to fit hot use without
 *  burning memory on every cell. Foreground/background are 24-bit ARGB
 *  or palette indices (negative for defaults). */
export interface CellAttrs {
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  inverse: boolean;
  underline: boolean;
  strike: boolean;
}

export const DEFAULT_ATTRS: CellAttrs = {
  fg: -1,
  bg: -1,
  bold: false,
  italic: false,
  dim: false,
  inverse: false,
  underline: false,
  strike: false,
};

export interface Cell {
  /** The character at this cell; "" for empty. UTF-16 code unit string;
   *  multi-codepoint sequences (emoji ZWJ) are not preserved beyond the
   *  first cluster. */
  ch: string;
  /** 1 for normal, 2 for east-asian wide (placeholder occupies next
   *  cell with ch="" + width=0). */
  width: 0 | 1 | 2;
  attrs: CellAttrs;
}

export function emptyCell(): Cell {
  return { ch: "", width: 1, attrs: { ...DEFAULT_ATTRS } };
}

/** Mutable row of cells. The buffer holds a flat array sliced into rows
 *  by `getRow(y)`. */
export class Row {
  cells: Cell[];
  /** True when this row was visually a continuation of the previous one
   *  (the terminal wrapped due to column overflow). xterm-search uses
   *  this to span across wrapped lines. */
  isWrapped: boolean;
  constructor(cols: number, isWrapped = false) {
    this.cells = new Array(cols);
    for (let i = 0; i < cols; i++) this.cells[i] = emptyCell();
    this.isWrapped = isWrapped;
  }
  resize(cols: number): void {
    if (cols > this.cells.length) {
      while (this.cells.length < cols) this.cells.push(emptyCell());
    } else if (cols < this.cells.length) {
      this.cells.length = cols;
    }
  }
  toString(trimRight = true): string {
    let s = "";
    for (const c of this.cells) s += c.ch || " ";
    return trimRight ? s.replace(/\s+$/u, "") : s;
  }
}

/** The main cell grid. Holds:
 *
 *   - `rows[]`     — current visible + scrollback rows. Index 0 is the
 *                    oldest scrollback line, length-1 is the bottom of
 *                    the viewport (or below if cursor scrolls).
 *   - `viewportY`  — index of the first visible row (top of viewport).
 *   - `cursorX/Y`  — cursor position in viewport-relative coords.
 *   - `attrs`      — current SGR pen, applied to subsequently-written cells.
 */
export class Grid {
  cols: number;
  rows: number;
  scrollback: number;
  /** Flat list of all rows (scrollback + viewport). New writes appear
   *  at the bottom; the cursor lives in the last `rows` of this list. */
  lines: Row[];
  cursorX = 0;
  cursorY = 0;
  /** Pen — copied into every cell on write. */
  attrs: CellAttrs = { ...DEFAULT_ATTRS };
  /** Saved cursor (DECSC). */
  savedCursorX = 0;
  savedCursorY = 0;
  savedAttrs: CellAttrs = { ...DEFAULT_ATTRS };
  /** Top/bottom of the scrolling region (0-based viewport coords). */
  scrollTop = 0;
  scrollBottom: number;
  /** Alternate screen flag — xterm switches buffers on DECSET 1049. */
  altActive = false;
  /** The "saved" alt buffer when alt isn't active. */
  altLines: Row[] | null = null;

  constructor(cols: number, rows: number, scrollback: number) {
    this.cols = cols;
    this.rows = rows;
    this.scrollback = scrollback;
    this.lines = [];
    for (let i = 0; i < rows; i++) this.lines.push(new Row(cols));
    this.scrollBottom = rows - 1;
  }

  /** Position in the `lines` array where the viewport starts. */
  get viewportTop(): number {
    return this.lines.length - this.rows;
  }

  rowAt(y: number): Row {
    return this.lines[this.viewportTop + y];
  }

  /** Write a single grapheme at the cursor and advance. Handles
   *  east-asian wide chars (advances by 2). */
  putChar(ch: string, width: 1 | 2 = 1): void {
    if (this.cursorX >= this.cols) {
      // wrap
      this.cursorX = 0;
      this.lineFeed(true);
    }
    const row = this.rowAt(this.cursorY);
    const cell = row.cells[this.cursorX];
    cell.ch = ch;
    cell.width = width;
    cell.attrs = { ...this.attrs };
    if (width === 2 && this.cursorX + 1 < this.cols) {
      const filler = row.cells[this.cursorX + 1];
      filler.ch = "";
      filler.width = 0;
      filler.attrs = { ...this.attrs };
    }
    this.cursorX += width;
  }

  /** LF / IND — move down within the scroll region, scrolling if at
   *  the bottom. `wrap=true` marks the new line as a wrap continuation. */
  lineFeed(wrap = false): void {
    if (this.cursorY >= this.scrollBottom) {
      this.scrollUp(1);
      // cursorY stays at scrollBottom after scroll-up
      if (wrap) this.rowAt(this.cursorY).isWrapped = true;
    } else {
      this.cursorY++;
      if (wrap) this.rowAt(this.cursorY).isWrapped = true;
    }
  }

  /** CR — cursor to col 0 (no row move). */
  carriageReturn(): void {
    this.cursorX = 0;
  }

  /** BS — cursor one column left, clamped at 0. */
  backspace(): void {
    if (this.cursorX > 0) this.cursorX--;
  }

  /** HT — advance to next tab stop (every 8 cols). */
  tab(): void {
    const next = ((Math.floor(this.cursorX / 8) + 1) * 8);
    this.cursorX = Math.min(next, this.cols - 1);
  }

  /** RI — cursor one row up, scrolling down if at scroll-top. */
  reverseIndex(): void {
    if (this.cursorY <= this.scrollTop) {
      this.scrollDown(1);
    } else {
      this.cursorY--;
    }
  }

  /** Scroll the region UP by `n` (new blank lines appear at the bottom;
   *  lines exit the top of the scroll region; the bottom of region scrolls
   *  off into scrollback when scroll-region == full screen). */
  scrollUp(n: number): void {
    if (n <= 0) return;
    const fullRegion = this.scrollTop === 0 && this.scrollBottom === this.rows - 1;
    for (let i = 0; i < n; i++) {
      if (fullRegion && !this.altActive) {
        // Top line moves into scrollback (just stays in the lines array,
        // viewportTop advances).
        this.lines.push(new Row(this.cols));
        // Drop scrollback overflow.
        const maxLines = this.rows + this.scrollback;
        if (this.lines.length > maxLines) {
          this.lines.splice(0, this.lines.length - maxLines);
        }
      } else {
        // Bounded region: rotate within the region in-place.
        const top = this.viewportTop + this.scrollTop;
        const bot = this.viewportTop + this.scrollBottom;
        this.lines.splice(top, 1);
        this.lines.splice(bot, 0, new Row(this.cols));
      }
    }
  }

  scrollDown(n: number): void {
    if (n <= 0) return;
    for (let i = 0; i < n; i++) {
      const top = this.viewportTop + this.scrollTop;
      const bot = this.viewportTop + this.scrollBottom;
      this.lines.splice(bot, 1);
      this.lines.splice(top, 0, new Row(this.cols));
    }
  }

  resize(cols: number, rows: number): void {
    if (cols !== this.cols) {
      for (const r of this.lines) r.resize(cols);
      this.cols = cols;
    }
    if (rows !== this.rows) {
      // Grow: append blank rows; shrink: trim from top of viewport.
      if (rows > this.rows) {
        for (let i = this.rows; i < rows; i++) this.lines.push(new Row(cols));
      } else if (rows < this.rows) {
        const trim = this.rows - rows;
        this.lines.splice(this.lines.length - trim, trim);
      }
      this.rows = rows;
      this.scrollBottom = Math.min(this.scrollBottom, rows - 1);
      this.cursorY = Math.min(this.cursorY, rows - 1);
    }
    this.cursorX = Math.min(this.cursorX, cols - 1);
  }

  /** Clear from cursor to end of line. */
  eraseToEol(): void {
    const row = this.rowAt(this.cursorY);
    for (let x = this.cursorX; x < this.cols; x++) {
      row.cells[x].ch = "";
      row.cells[x].width = 1;
      row.cells[x].attrs = { ...this.attrs };
    }
  }
  eraseToBol(): void {
    const row = this.rowAt(this.cursorY);
    for (let x = 0; x <= this.cursorX && x < this.cols; x++) {
      row.cells[x].ch = "";
      row.cells[x].width = 1;
      row.cells[x].attrs = { ...this.attrs };
    }
  }
  eraseLine(): void {
    const row = this.rowAt(this.cursorY);
    for (let x = 0; x < this.cols; x++) {
      row.cells[x].ch = "";
      row.cells[x].width = 1;
      row.cells[x].attrs = { ...this.attrs };
    }
  }
  /** ED — erase display. mode 0 = below, 1 = above, 2 = all. */
  eraseDisplay(mode: 0 | 1 | 2): void {
    if (mode === 2) {
      for (let y = 0; y < this.rows; y++) {
        const row = this.rowAt(y);
        for (let x = 0; x < this.cols; x++) {
          row.cells[x].ch = "";
          row.cells[x].width = 1;
          row.cells[x].attrs = { ...this.attrs };
        }
      }
    } else if (mode === 0) {
      this.eraseToEol();
      for (let y = this.cursorY + 1; y < this.rows; y++) {
        const row = this.rowAt(y);
        for (let x = 0; x < this.cols; x++) {
          row.cells[x].ch = "";
          row.cells[x].width = 1;
          row.cells[x].attrs = { ...this.attrs };
        }
      }
    } else if (mode === 1) {
      this.eraseToBol();
      for (let y = 0; y < this.cursorY; y++) {
        const row = this.rowAt(y);
        for (let x = 0; x < this.cols; x++) {
          row.cells[x].ch = "";
          row.cells[x].width = 1;
          row.cells[x].attrs = { ...this.attrs };
        }
      }
    }
  }

  /** Switch to / from alt screen. Saves the primary buffer's bottom
   *  `rows` lines so the user's content survives intact when alt
   *  finishes (fullscreen apps like vim/less rely on this). */
  setAltScreen(on: boolean): void {
    if (on === this.altActive) return;
    if (on) {
      // Save current viewport so we can restore on exit.
      this.altLines = this.lines.slice(-this.rows);
      const fresh: Row[] = [];
      for (let i = 0; i < this.rows; i++) fresh.push(new Row(this.cols));
      this.lines = fresh;
      this.altActive = true;
    } else {
      if (this.altLines) {
        this.lines.push(...this.altLines.slice(0, this.rows));
        this.lines = this.lines.slice(-(this.rows + this.scrollback));
        this.altLines = null;
      }
      this.altActive = false;
    }
  }
}

// ─── xterm.js-shaped buffer adapters over Grid ──────────────────────────

class BufferCellAdapter implements IBufferCell {
  constructor(private cell: Cell) {}
  getWidth(): 1 | 2 {
    const w = this.cell.width;
    return w === 2 ? 2 : 1;
  }
  getChars(): string { return this.cell.ch; }
  getCode(): number { return this.cell.ch.codePointAt(0) ?? 0; }
  getFgColor(): number { return this.cell.attrs.fg; }
  getFgColorMode(): number { return 0; }
  getBgColor(): number { return this.cell.attrs.bg; }
  getBgColorMode(): number { return 0; }
  isBold(): boolean { return this.cell.attrs.bold; }
  isItalic(): boolean { return this.cell.attrs.italic; }
  isDim(): boolean { return this.cell.attrs.dim; }
  isInverse(): boolean { return this.cell.attrs.inverse; }
  isInvisible(): boolean { return false; }
  isUnderline(): boolean { return this.cell.attrs.underline; }
  isBlink(): boolean { return false; }
  isStrikethrough(): boolean { return this.cell.attrs.strike; }
  isOverline(): boolean { return false; }
}

class BufferLineAdapter implements IBufferLine {
  constructor(private row: Row) {}
  get isWrapped(): boolean { return this.row.isWrapped; }
  get length(): number { return this.row.cells.length; }
  getCell(x: number): IBufferCell | undefined {
    const c = this.row.cells[x];
    return c ? new BufferCellAdapter(c) : undefined;
  }
  translateToString(trimRight = false, startCol = 0, endCol?: number): string {
    let s = "";
    const end = endCol ?? this.row.cells.length;
    for (let x = startCol; x < end; x++) s += this.row.cells[x]?.ch || " ";
    return trimRight ? s.replace(/\s+$/u, "") : s;
  }
}

class BufferAdapter implements IBuffer {
  constructor(private grid: Grid, public type: "normal" | "alternate") {}
  get cursorY(): number { return this.grid.cursorY; }
  get cursorX(): number { return this.grid.cursorX; }
  get viewportY(): number { return 0; }
  get baseY(): number { return Math.max(0, this.grid.lines.length - this.grid.rows); }
  get length(): number { return this.grid.lines.length; }
  getLine(y: number): IBufferLine | undefined {
    const row = this.grid.lines[y];
    return row ? new BufferLineAdapter(row) : undefined;
  }
}

export class BufferNamespace implements IBufferNamespace {
  private bufferChange = new Emitter<IBuffer>();
  constructor(private grid: Grid) {}
  get active(): IBuffer {
    return new BufferAdapter(this.grid, this.grid.altActive ? "alternate" : "normal");
  }
  get normal(): IBuffer { return new BufferAdapter(this.grid, "normal"); }
  get alternate(): IBuffer { return new BufferAdapter(this.grid, "alternate"); }
  onBufferChange(cb: (buffer: IBuffer) => void): IDisposable {
    return this.bufferChange.event(cb);
  }
  /** Internal — fire when the alt buffer toggles. */
  _fireChange(): void {
    this.bufferChange.fire(this.active);
  }
}
