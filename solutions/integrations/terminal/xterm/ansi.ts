// VT100/xterm escape-sequence parser.
//
// Streams input through a state machine:
//
//   ground            — plain text + control chars (BS, LF, CR, ...)
//   esc               — saw 0x1b, waiting for the next byte
//   csi-entry / param — Control Sequence Introducer; collects params + final
//   osc               — Operating System Command (ESC ] ... ST)
//   dcs               — Device Control String (skipped to terminator)
//
// We support the subset the average shell + fastfetch + oh-my-posh + git
// pager + less / vim status line / etc. emit:
//
//   SGR  — colors, bold, italic, dim, inverse, underline, strike, reset
//   CUU/CUD/CUF/CUB    — cursor up/down/forward/back
//   CUP/HVP            — absolute cursor position
//   ED/EL              — erase display / line (with mode)
//   IL/DL              — insert/delete lines
//   ICH/DCH            — insert/delete chars
//   DECSTBM            — set scroll region
//   DECSET/DECRST 25   — show/hide cursor
//   DECSET/DECRST 1049 — alt screen + save cursor
//   DECSC/DECRC        — save/restore cursor
//   OSC 0/2            — set window title
//   OSC 8              — hyperlink (handled by web-links addon; we just
//                        pass through)
//
// Anything we don't recognise is logged (in dev) and otherwise ignored.

import type { Grid, CellAttrs } from "./grid";

export interface AnsiSinks {
  /** Called when OSC 0/2 lands — `setWindowTitle(text)`. */
  onTitleChange?: (title: string) => void;
  /** Called for an OSC 8 hyperlink wrap — we don't track per-cell links
   *  here; the web-links addon can scan the text instead. */
  onHyperlink?: (uri: string | null) => void;
}

export class AnsiParser {
  private state: "ground" | "esc" | "csi" | "osc" | "dcs" = "ground";
  private params: number[] = [];
  private paramBuf = "";
  private intermediate = "";
  private oscBuf = "";
  /** Bytes accumulated for a multi-byte UTF-8 codepoint in progress. */
  private utf8Buf: number[] = [];
  private utf8Need = 0;
  /** App-registered OSC handlers keyed by command number (xterm
   *  `parser.registerOscHandler(ident, cb)`). Used for shell integration:
   *  OSC 7 (cwd), OSC 133 (prompt marks), etc. */
  private oscHandlers = new Map<number, ((data: string) => boolean)[]>();

  constructor(private grid: Grid, private sinks: AnsiSinks = {}) {}

  /** Register a handler for OSC sequences with the given command number.
   *  Matches xterm.js's `IParser.registerOscHandler` — the callback gets
   *  the OSC payload (everything after `<ident>;`) and returns whether it
   *  handled the sequence. Returns a disposable. */
  registerOscHandler(
    ident: number,
    handler: (data: string) => boolean,
  ): { dispose(): void } {
    let arr = this.oscHandlers.get(ident);
    if (!arr) { arr = []; this.oscHandlers.set(ident, arr); }
    arr.push(handler);
    return {
      dispose: () => {
        const a = this.oscHandlers.get(ident);
        if (!a) return;
        const i = a.indexOf(handler);
        if (i >= 0) a.splice(i, 1);
      },
    };
  }

  /** Feed input. Idempotent across chunks — partial sequences are
   *  preserved in `state` + `paramBuf` etc. across calls. */
  feed(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const cu = data.charCodeAt(i);
      this.step(cu, data, i);
    }
  }

  private step(c: number, src: string, i: number): void {
    if (this.state === "ground") {
      this.handleGround(c, src, i);
      return;
    }
    if (this.state === "esc") {
      this.handleEsc(c);
      return;
    }
    if (this.state === "csi") {
      this.handleCsi(c);
      return;
    }
    if (this.state === "osc") {
      this.handleOsc(c);
      return;
    }
    if (this.state === "dcs") {
      // Skip to ST (ESC \) or BEL.
      if (c === 0x1b) this.state = "esc";
      if (c === 0x07) this.state = "ground";
    }
  }

  private handleGround(c: number, src: string, _i: number): void {
    // Control bytes first.
    if (c === 0x1b) { this.state = "esc"; return; } // ESC
    if (c === 0x07) return;                          // BEL
    if (c === 0x08) { this.grid.backspace(); return; }
    if (c === 0x09) { this.grid.tab(); return; }
    if (c === 0x0a) { this.grid.lineFeed(); return; }
    if (c === 0x0b) { this.grid.lineFeed(); return; } // VT — same as LF
    if (c === 0x0c) { this.grid.lineFeed(); return; } // FF — same as LF
    if (c === 0x0d) { this.grid.carriageReturn(); return; }
    if (c < 0x20) return; // ignore other C0 controls

    // UTF-8 multi-byte decode. JS strings are UTF-16, but the runtime's
    // PTY hands us bytes encoded as one code unit per byte — so we
    // re-assemble Unicode codepoints here. This is what makes braille
    // (U+28xx) and box-drawing (U+25xx) render correctly when the
    // shell emits them as 3-byte UTF-8 sequences.
    if (this.utf8Need > 0) {
      this.utf8Buf.push(c);
      this.utf8Need--;
      if (this.utf8Need === 0) {
        const codePoint = this.decodeUtf8();
        this.utf8Buf = [];
        this.grid.putChar(
          String.fromCodePoint(codePoint),
          isWideCodePoint(codePoint) ? 2 : 1,
        );
      }
      return;
    }
    if (c >= 0xc2 && c <= 0xdf) {
      this.utf8Buf = [c];
      this.utf8Need = 1;
      return;
    }
    if (c >= 0xe0 && c <= 0xef) {
      this.utf8Buf = [c];
      this.utf8Need = 2;
      return;
    }
    if (c >= 0xf0 && c <= 0xf4) {
      this.utf8Buf = [c];
      this.utf8Need = 3;
      return;
    }

    // Plain ASCII / Latin-1 range (no UTF-8 lead).
    this.grid.putChar(src.charAt(_i), 1);
  }

  private decodeUtf8(): number {
    const b = this.utf8Buf;
    if (b.length === 2) {
      return ((b[0] & 0x1f) << 6) | (b[1] & 0x3f);
    }
    if (b.length === 3) {
      return ((b[0] & 0x0f) << 12) | ((b[1] & 0x3f) << 6) | (b[2] & 0x3f);
    }
    if (b.length === 4) {
      return ((b[0] & 0x07) << 18) | ((b[1] & 0x3f) << 12) | ((b[2] & 0x3f) << 6) | (b[3] & 0x3f);
    }
    return 0xfffd;
  }

  private handleEsc(c: number): void {
    // ESC c — full reset
    if (c === 0x63) {
      this.grid.cursorX = 0;
      this.grid.cursorY = 0;
      this.grid.eraseDisplay(2);
      this.state = "ground";
      return;
    }
    // ESC 7 — DECSC (save cursor)
    if (c === 0x37) {
      this.grid.savedCursorX = this.grid.cursorX;
      this.grid.savedCursorY = this.grid.cursorY;
      this.grid.savedAttrs = { ...this.grid.attrs };
      this.state = "ground";
      return;
    }
    // ESC 8 — DECRC (restore cursor)
    if (c === 0x38) {
      this.grid.cursorX = this.grid.savedCursorX;
      this.grid.cursorY = this.grid.savedCursorY;
      this.grid.attrs = { ...this.grid.savedAttrs };
      this.state = "ground";
      return;
    }
    // ESC D — IND (index — same as LF)
    if (c === 0x44) { this.grid.lineFeed(); this.state = "ground"; return; }
    // ESC E — NEL (next line)
    if (c === 0x45) { this.grid.carriageReturn(); this.grid.lineFeed(); this.state = "ground"; return; }
    // ESC M — RI (reverse index)
    if (c === 0x4d) { this.grid.reverseIndex(); this.state = "ground"; return; }
    // ESC [ — CSI
    if (c === 0x5b) {
      this.params = [];
      this.paramBuf = "";
      this.intermediate = "";
      this.state = "csi";
      return;
    }
    // ESC ] — OSC
    if (c === 0x5d) {
      this.oscBuf = "";
      this.state = "osc";
      return;
    }
    // ESC P — DCS
    if (c === 0x50) {
      this.state = "dcs";
      return;
    }
    // Anything else — return to ground.
    this.state = "ground";
  }

  private handleCsi(c: number): void {
    // Parameter bytes 0x30..0x3f (digits, ;, ?, etc.)
    if ((c >= 0x30 && c <= 0x39) || c === 0x3b || c === 0x3a) {
      this.paramBuf += String.fromCharCode(c);
      return;
    }
    if (c === 0x3f || c === 0x3e || c === 0x3c || c === 0x3d) {
      // Private-mode prefix — store as intermediate.
      this.intermediate += String.fromCharCode(c);
      return;
    }
    // Intermediate bytes 0x20..0x2f
    if (c >= 0x20 && c <= 0x2f) {
      this.intermediate += String.fromCharCode(c);
      return;
    }
    // Final byte 0x40..0x7e
    if (c >= 0x40 && c <= 0x7e) {
      this.params = this.paramBuf.split(";").map((s) => (s === "" ? 0 : parseInt(s, 10) || 0));
      this.dispatchCsi(String.fromCharCode(c));
      this.state = "ground";
      this.paramBuf = "";
      this.intermediate = "";
      return;
    }
  }

  private dispatchCsi(final: string): void {
    const p = this.params;
    const arg = (i: number, fallback: number) => (p[i] === undefined ? fallback : p[i] || fallback);

    switch (final) {
      case "A": this.grid.cursorY = Math.max(0, this.grid.cursorY - arg(0, 1)); return;
      case "B": this.grid.cursorY = Math.min(this.grid.rows - 1, this.grid.cursorY + arg(0, 1)); return;
      case "C": this.grid.cursorX = Math.min(this.grid.cols - 1, this.grid.cursorX + arg(0, 1)); return;
      case "D": this.grid.cursorX = Math.max(0, this.grid.cursorX - arg(0, 1)); return;
      case "E": this.grid.cursorX = 0; this.grid.cursorY = Math.min(this.grid.rows - 1, this.grid.cursorY + arg(0, 1)); return;
      case "F": this.grid.cursorX = 0; this.grid.cursorY = Math.max(0, this.grid.cursorY - arg(0, 1)); return;
      case "G": this.grid.cursorX = Math.max(0, Math.min(this.grid.cols - 1, arg(0, 1) - 1)); return;
      case "H": case "f": {
        const y = arg(0, 1) - 1;
        const x = arg(1, 1) - 1;
        this.grid.cursorY = Math.max(0, Math.min(this.grid.rows - 1, y));
        this.grid.cursorX = Math.max(0, Math.min(this.grid.cols - 1, x));
        return;
      }
      case "J": this.grid.eraseDisplay((arg(0, 0) as 0 | 1 | 2)); return;
      case "K": {
        const mode = arg(0, 0);
        if (mode === 0) this.grid.eraseToEol();
        else if (mode === 1) this.grid.eraseToBol();
        else if (mode === 2) this.grid.eraseLine();
        return;
      }
      case "L": this.grid.scrollDown(arg(0, 1)); return; // IL (at cursor row, but we approximate)
      case "M": this.grid.scrollUp(arg(0, 1)); return;   // DL
      case "S": this.grid.scrollUp(arg(0, 1)); return;   // SU
      case "T": this.grid.scrollDown(arg(0, 1)); return; // SD
      case "P": {
        // DCH — delete chars at cursor, shift right.
        const n = arg(0, 1);
        const row = this.grid.rowAt(this.grid.cursorY);
        row.cells.splice(this.grid.cursorX, n);
        while (row.cells.length < this.grid.cols) {
          row.cells.push({ ch: "", width: 1, attrs: { ...this.grid.attrs } });
        }
        return;
      }
      case "@": {
        // ICH — insert chars, shift right.
        const n = arg(0, 1);
        const row = this.grid.rowAt(this.grid.cursorY);
        const blanks: typeof row.cells = [];
        for (let i = 0; i < n; i++) blanks.push({ ch: "", width: 1, attrs: { ...this.grid.attrs } });
        row.cells.splice(this.grid.cursorX, 0, ...blanks);
        row.cells.length = this.grid.cols;
        return;
      }
      case "d": this.grid.cursorY = Math.max(0, Math.min(this.grid.rows - 1, arg(0, 1) - 1)); return;
      case "r": {
        const top = arg(0, 1) - 1;
        const bot = arg(1, this.grid.rows) - 1;
        this.grid.scrollTop = Math.max(0, top);
        this.grid.scrollBottom = Math.min(this.grid.rows - 1, bot);
        this.grid.cursorX = 0;
        this.grid.cursorY = 0;
        return;
      }
      case "m": this.applySgr(p); return;
      case "h": case "l": this.applyMode(p, this.intermediate, final === "h"); return;
      case "n":
        // DSR — device status report. 6 = report cursor position.
        // We don't have a back-channel here; some apps need it. Ignore.
        return;
      case "c":
        // DA — device attributes. Same — ignore.
        return;
    }
    // Unknown CSI — silently drop.
  }

  private applyMode(params: number[], intermediate: string, set: boolean): void {
    const isPrivate = intermediate === "?";
    for (const param of params) {
      if (!isPrivate) continue;
      switch (param) {
        case 25:
          // Show/hide cursor — we don't model visibility here; the
          // renderer can ask the terminal via `cursorVisible`.
          // (Stored for future use.)
          break;
        case 47:
        case 1047:
        case 1049:
          this.grid.setAltScreen(set);
          if (param === 1049 && set) {
            this.grid.savedCursorX = this.grid.cursorX;
            this.grid.savedCursorY = this.grid.cursorY;
            this.grid.cursorX = 0;
            this.grid.cursorY = 0;
          } else if (param === 1049 && !set) {
            this.grid.cursorX = this.grid.savedCursorX;
            this.grid.cursorY = this.grid.savedCursorY;
          }
          break;
        case 1048:
          if (set) {
            this.grid.savedCursorX = this.grid.cursorX;
            this.grid.savedCursorY = this.grid.cursorY;
          } else {
            this.grid.cursorX = this.grid.savedCursorX;
            this.grid.cursorY = this.grid.savedCursorY;
          }
          break;
      }
    }
  }

  private applySgr(params: number[]): void {
    if (params.length === 0) params = [0];
    const a: CellAttrs = { ...this.grid.attrs };
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) Object.assign(a, { fg: -1, bg: -1, bold: false, italic: false, dim: false, inverse: false, underline: false, strike: false });
      else if (p === 1) a.bold = true;
      else if (p === 2) a.dim = true;
      else if (p === 3) a.italic = true;
      else if (p === 4) a.underline = true;
      else if (p === 7) a.inverse = true;
      else if (p === 9) a.strike = true;
      else if (p === 22) { a.bold = false; a.dim = false; }
      else if (p === 23) a.italic = false;
      else if (p === 24) a.underline = false;
      else if (p === 27) a.inverse = false;
      else if (p === 29) a.strike = false;
      else if (p >= 30 && p <= 37) a.fg = p - 30;
      else if (p === 38) {
        // Extended fg — 5;n (palette) or 2;r;g;b (truecolor).
        const mode = params[i + 1];
        if (mode === 5) { a.fg = params[i + 2] ?? 0; i += 2; }
        else if (mode === 2) {
          const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
          a.fg = (0xff << 24) | (r << 16) | (g << 8) | b;
          i += 4;
        }
      }
      else if (p === 39) a.fg = -1;
      else if (p >= 40 && p <= 47) a.bg = p - 40;
      else if (p === 48) {
        const mode = params[i + 1];
        if (mode === 5) { a.bg = params[i + 2] ?? 0; i += 2; }
        else if (mode === 2) {
          const r = params[i + 2] ?? 0, g = params[i + 3] ?? 0, b = params[i + 4] ?? 0;
          a.bg = (0xff << 24) | (r << 16) | (g << 8) | b;
          i += 4;
        }
      }
      else if (p === 49) a.bg = -1;
      else if (p >= 90 && p <= 97) a.fg = p - 90 + 8;
      else if (p >= 100 && p <= 107) a.bg = p - 100 + 8;
    }
    this.grid.attrs = a;
  }

  private handleOsc(c: number): void {
    // OSC terminates on BEL (0x07) or ST (ESC \).
    if (c === 0x07 || (c === 0x5c && this.oscBuf.endsWith("\x1b"))) {
      let body = this.oscBuf;
      if (c === 0x5c) body = body.slice(0, -1);
      this.dispatchOsc(body);
      this.state = "ground";
      this.oscBuf = "";
      return;
    }
    this.oscBuf += String.fromCharCode(c);
  }

  private dispatchOsc(body: string): void {
    // Body is "Ps;Pt" where Ps is the command number.
    const semi = body.indexOf(";");
    if (semi < 0) return;
    const ps = parseInt(body.slice(0, semi), 10);
    const pt = body.slice(semi + 1);
    if (ps === 0 || ps === 2) {
      this.sinks.onTitleChange?.(pt);
    } else if (ps === 8) {
      // OSC 8;;<uri> opens, OSC 8;; closes — pass through, web-links
      // addon can scan if needed.
      this.sinks.onHyperlink?.(pt.split(";")[1] || null);
    }
    // App-registered handlers (shell integration: OSC 7 cwd, OSC 133
    // prompt marks, etc.). Most-recently-registered first; stop once one
    // claims the sequence (xterm.js semantics).
    const handlers = this.oscHandlers.get(ps);
    if (handlers) {
      for (let i = handlers.length - 1; i >= 0; i--) {
        try { if (handlers[i](pt)) break; } catch { /* keep going */ }
      }
    }
  }
}

/** Crude east-asian wide-char test. Covers the ranges that matter for
 *  terminal layout (CJK, emoji, fullwidth forms). */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||      // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||      // CJK Radicals + Symbols
    (cp >= 0x3041 && cp <= 0x33ff) ||      // Hiragana/Katakana/CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||      // CJK Ext-A
    (cp >= 0x4e00 && cp <= 0x9fff) ||      // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||      // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||      // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||      // CJK Compatibility
    (cp >= 0xfe30 && cp <= 0xfe4f) ||      // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) ||      // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1ffff)       // emoji-ish
  );
}
