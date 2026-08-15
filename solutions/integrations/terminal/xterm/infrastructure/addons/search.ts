// @xterm/addon-search replacement. Linear scan of the buffer for a
// substring; updates the active "current match" index across calls.
// Decorations (highlight selected/all) aren't visually rendered yet —
// the addon just tells the Terminal where the match is via the
// onDidChangeResults callback.

import type { ITerminal, ITerminalAddon } from "../../domain/types.ts";

export interface ISearchOptions {
  regex?: boolean;
  wholeWord?: boolean;
  caseSensitive?: boolean;
  incremental?: boolean;
  decorations?: {
    matchBackground?: string;
    matchBorder?: string;
    matchOverviewRuler?: string;
    activeMatchBackground?: string;
    activeMatchBorder?: string;
    activeMatchColorOverviewRuler?: string;
  };
}

export interface ISearchResult {
  /** Index (1-based) of the active match in the result list. */
  resultIndex: number;
  resultCount: number;
}

type ChangeCb = (e: ISearchResult | undefined) => void;

export class SearchAddon implements ITerminalAddon {
  private term: ITerminal | null = null;
  private changeListeners = new Set<ChangeCb>();
  private lastResults: { line: number; start: number; end: number }[] = [];
  private activeIdx = -1;

  activate(term: ITerminal): void { this.term = term; }
  dispose(): void { this.term = null; this.changeListeners.clear(); }

  onDidChangeResults(cb: ChangeCb): { dispose: () => void } {
    this.changeListeners.add(cb);
    return { dispose: () => { this.changeListeners.delete(cb); } };
  }

  findNext(query: string, opts: ISearchOptions = {}): boolean {
    return this.find(query, opts, +1);
  }
  findPrevious(query: string, opts: ISearchOptions = {}): boolean {
    return this.find(query, opts, -1);
  }
  clearDecorations(): void {
    this.lastResults = [];
    this.activeIdx = -1;
    this.fireChange();
  }
  clearActiveDecoration(): void { this.activeIdx = -1; this.fireChange(); }

  private find(query: string, opts: ISearchOptions, dir: 1 | -1): boolean {
    if (!this.term || !query) {
      this.lastResults = [];
      this.activeIdx = -1;
      this.fireChange();
      return false;
    }
    const buffer = this.term.buffer.active;
    const haystack: string[] = [];
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      haystack.push(line?.translateToString(false) ?? "");
    }
    const flags = opts.caseSensitive ? "g" : "gi";
    const pattern = opts.regex
      ? new RegExp(query, flags)
      : new RegExp(escapeRegex(query), flags);
    const results: { line: number; start: number; end: number }[] = [];
    for (let y = 0; y < haystack.length; y++) {
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(haystack[y])) !== null) {
        if (opts.wholeWord) {
          const before = haystack[y][m.index - 1];
          const after = haystack[y][m.index + m[0].length];
          if (isWordChar(before) || isWordChar(after)) {
            if (m[0].length === 0) pattern.lastIndex++;
            continue;
          }
        }
        results.push({ line: y, start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) pattern.lastIndex++;
      }
    }
    this.lastResults = results;
    if (results.length === 0) {
      this.activeIdx = -1;
      this.fireChange();
      return false;
    }
    if (dir === 1) {
      this.activeIdx = this.activeIdx >= results.length - 1 ? 0 : this.activeIdx + 1;
    } else {
      this.activeIdx = this.activeIdx <= 0 ? results.length - 1 : this.activeIdx - 1;
    }
    this.fireChange();
    return true;
  }

  private fireChange(): void {
    const ev: ISearchResult | undefined = this.activeIdx < 0
      ? undefined
      : { resultIndex: this.activeIdx + 1, resultCount: this.lastResults.length };
    for (const cb of Array.from(this.changeListeners)) {
      try { cb(ev); } catch (e) { console.error("[xterm-shim] search:", e); }
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isWordChar(c: string | undefined): boolean {
  return !!c && /[\w]/.test(c);
}
