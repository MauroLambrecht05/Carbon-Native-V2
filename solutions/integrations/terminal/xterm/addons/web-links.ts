// @xterm/addon-web-links replacement. Scans cells for http(s)/file URLs
// and underlines them on hover with a click handler. Real xterm uses
// decoration ranges; we approximate by post-render-scanning each line's
// text content and wrapping matched substrings in a <span> with an
// onclick that calls back into the user's handler.

import type { ITerminal, ITerminalAddon } from "../types";

const URL_RE = /(https?:\/\/|file:\/\/)[^\s]+[^\s.,:;!?'")\]}]/g;

export type LinkClickHandler = (event: MouseEvent, uri: string) => void;

export class WebLinksAddon implements ITerminalAddon {
  private term: ITerminal | null = null;
  private renderSub: { dispose: () => void } | null = null;

  constructor(private handler?: LinkClickHandler, private _options?: unknown) {}

  activate(term: ITerminal): void {
    this.term = term;
    this.renderSub = term.onRender(() => this.rescan());
    // Initial scan.
    this.rescan();
  }
  dispose(): void {
    this.renderSub?.dispose();
    this.renderSub = null;
    this.term = null;
  }

  private rescan(): void {
    // The shim renders each line as a <div> with per-cell <span>s. We
    // post-process by walking the viewport's row containers and looking
    // for URL substrings in their text content; matched ranges get the
    // current row's cell spans wrapped with an inline-style underline
    // + onclick. This is best-effort — overlapping URLs across cell
    // boundaries are matched but the click target is the first cell.
    const term = this.term;
    if (!term || !term.element) return;
    const viewport = term.element.firstChild as HTMLElement | null;
    if (!viewport) return;
    const handler = this.handler;
    const children = viewport.children;
    for (let i = 0; i < children.length; i++) {
      const row = children[i] as HTMLElement;
      // Aggregate the row's plain text.
      const text = (row.textContent ?? "");
      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        const uri = m[0];
        // Walk the cell spans and toggle the link styling/handler on
        // those whose flat-column index falls inside [start, end).
        const cellNodes = row.children;
        for (let c = 0; c < cellNodes.length; c++) {
          if (c < start || c >= end) continue;
          const cellEl = cellNodes[c] as HTMLElement;
          cellEl.style.textDecoration = "underline";
          cellEl.style.cursor = "pointer";
          (cellEl as unknown as { __cmLinkUri?: string }).__cmLinkUri = uri;
          if (handler) {
            cellEl.onclick = (e: MouseEvent) => {
              try { handler(e, uri); } catch (err) { console.error("[xterm-shim] link:", err); }
            };
          }
        }
      }
    }
  }
}
