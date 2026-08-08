// @xterm/addon-fit replacement. Measures the terminal's CONTAINER and
// resizes the grid to match. Real xterm uses Canvas2D measureText for
// pixel-accurate cell dimensions; we approximate from font-size since the
// shim renders text via inline-block <span>s in monospace.
//
// We measure the container (the host element's parent), NOT the host
// itself: the host is `width:100%;height:100%` and, depending on how the
// engine resolves percentage heights, can size to its own content (the
// terminal viewport) rather than the pane — which would feed fit a
// runaway height and propose thousands of rows. The container (the element
// the app mounted the terminal into) always carries the intended box.

import type { ITerminal, ITerminalAddon } from "../types";

// Defensive caps: a terminal larger than this is always a measurement bug,
// and resize() allocates cols×rows scene nodes — an unbounded value hangs
// the renderer.
const MAX_COLS = 1000;
const MAX_ROWS = 1000;

function measureBox(term: ITerminal | null): { width: number; height: number } {
  const host = term?.element as
    | { getBoundingClientRect?: () => { width: number; height: number }; parentNode?: any }
    | undefined;
  if (!host) return { width: 0, height: 0 };
  // Prefer the container (parent); fall back to the host itself.
  const target =
    (host.parentNode && host.parentNode.getBoundingClientRect)
      ? host.parentNode
      : host;
  const rect = target.getBoundingClientRect
    ? target.getBoundingClientRect()
    : { width: 0, height: 0 };
  return { width: rect.width || 0, height: rect.height || 0 };
}

function dims(term: ITerminal): { cols: number; rows: number } {
  const opts =
    (term as unknown as { options?: { fontSize?: number; lineHeight?: number } })
      .options ?? {};
  const fontSize = opts.fontSize ?? 14;
  const cellW = fontSize * 0.6;
  const cellH = fontSize * (opts.lineHeight ?? 1.2);
  const { width, height } = measureBox(term);
  const cols = Math.min(MAX_COLS, Math.max(1, Math.floor(width / cellW)));
  const rows = Math.min(MAX_ROWS, Math.max(1, Math.floor(height / cellH)));
  return { cols, rows };
}

export class FitAddon implements ITerminalAddon {
  private term: ITerminal | null = null;
  activate(term: ITerminal): void { this.term = term; }
  dispose(): void { this.term = null; }
  /** Compute new (cols, rows) from the container size and call
   *  term.resize(). Safe to call from a ResizeObserver. */
  fit(): void {
    if (!this.term?.element) return;
    const { cols, rows } = dims(this.term);
    this.term.resize(cols, rows);
  }
  /** Returns what fit() WOULD resize to, without actually resizing. */
  proposeDimensions(): { cols: number; rows: number } | undefined {
    if (!this.term?.element) return undefined;
    return dims(this.term);
  }
}
