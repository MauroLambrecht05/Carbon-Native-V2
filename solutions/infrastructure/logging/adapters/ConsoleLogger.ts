// Console implementation of the Logger port.
//
// picocolors handles "no TTY" and FORCE_COLOR cleanly, so nothing here needs
// to branch on whether output is a terminal.

import pc from "picocolors";
import type { Logger } from "../ports/Logger.ts";

export const log = {
  info: (msg: string) => console.log(`${pc.cyan("›")} ${msg}`),
  step: (msg: string) => console.log(`${pc.dim("·")} ${pc.dim(msg)}`),
  success: (msg: string) => console.log(`${pc.green("✓")} ${msg}`),
  warn: (msg: string) => console.warn(`${pc.yellow("!")} ${msg}`),
  error: (msg: string) => console.error(`${pc.red("✗")} ${msg}`),
  raw: (msg: string) => console.log(msg),
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
