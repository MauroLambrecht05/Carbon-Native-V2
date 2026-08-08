// @xterm/addon-serialize replacement. Dumps the buffer to a string of
// ANSI sequences a fresh Terminal can replay. Used by terax-ai's
// `dormantRing` to snapshot a paused terminal's content for restore.

import type { ITerminal, ITerminalAddon } from "../types";

export class SerializeAddon implements ITerminalAddon {
  private term: ITerminal | null = null;
  activate(term: ITerminal): void { this.term = term; }
  dispose(): void { this.term = null; }

  /** Serialize the active buffer's visible viewport + scrollback into a
   *  string of ANSI sequences. Replaying it on a fresh Terminal restores
   *  the visible content (colors, cursor position, and most SGR state).
   *  Width/height info aren't included; the caller restores those
   *  out-of-band via `term.resize(cols, rows)`.
   *
   *  Options match xterm.js's: `scrollback` caps the # of scrollback
   *  lines to include (default = all). `excludeAltBuffer` skips the
   *  alternate buffer when active. */
  serialize(opts: { scrollback?: number; excludeAltBuffer?: boolean; excludeModes?: boolean } = {}): string {
    if (!this.term) return "";
    const buffer = this.term.buffer.active;
    const len = buffer.length;
    const cap = opts.scrollback ?? Number.POSITIVE_INFINITY;
    const start = Math.max(0, len - cap);
    const out: string[] = [];
    out.push("\x1bc"); // reset terminal first
    for (let y = start; y < len; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      out.push(line.translateToString(false));
      if (y < len - 1) out.push("\r\n");
    }
    // Move cursor to its current spot.
    out.push(`\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`);
    return out.join("");
  }

  serializeAsHTML(): string {
    return this.serialize().replace(/[<>&]/g, (c) =>
      c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
    );
  }
}
