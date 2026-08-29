// Console implementation of the Logger port.
//
// picocolors handles "no TTY" and FORCE_COLOR cleanly, so nothing here needs
// to branch on whether output is a terminal.

import pc from "picocolors";
import type { Logger } from "../ports/Logger.ts";

/**
 * A sink lets a presentation-layer caller (e.g. a CLI status line) intercept
 * every `log.*` call — including the ones made deep inside use cases that
 * import the `log` singleton directly rather than taking a Logger param —
 * without threading a "quiet mode" flag through every layer in between.
 * Installing one is opt-in and reversible; with none installed (the default)
 * behavior is exactly what it was before this existed.
 */
export type LogKind = "info" | "step" | "success" | "warn" | "error" | "raw";
export type LogSink = (kind: LogKind, msg: string) => void;

let sink: LogSink | null = null;

/** Installs `next` as the sink and returns the previous one, so a caller can
 *  restore it when done (nesting-safe: `setLogSink(prev)` in a `finally`). */
export function setLogSink(next: LogSink | null): LogSink | null {
  const prev = sink;
  sink = next;
  return prev;
}

export const log = {
  info: (msg: string) => sink ? sink("info", msg) : console.log(`${pc.cyan("›")} ${msg}`),
  step: (msg: string) => sink ? sink("step", msg) : console.log(`${pc.dim("·")} ${pc.dim(msg)}`),
  success: (msg: string) => sink ? sink("success", msg) : console.log(`${pc.green("✓")} ${msg}`),
  warn: (msg: string) => sink ? sink("warn", msg) : console.warn(`${pc.yellow("!")} ${msg}`),
  error: (msg: string) => sink ? sink("error", msg) : console.error(`${pc.red("✗")} ${msg}`),
  raw: (msg: string) => sink ? sink("raw", msg) : console.log(msg),
} satisfies Logger;

/** Colour helpers. Presentation only — nothing in domain/ should reach for these. */
export const c = pc;

/** Collects lines instead of printing them. For tests. */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(m: string) { this.lines.push(m); }
  step(m: string) { this.lines.push(m); }
  success(m: string) { this.lines.push(m); }
  warn(m: string) { this.lines.push(m); }
  error(m: string) { this.lines.push(m); }
  raw(m: string) { this.lines.push(m); }
  get text(): string { return this.lines.join("\n"); }
}
