// Console implementations of the Io port.
//
// The default forwards to @carbon/toolchain's console logger, so the CLI's
// output format is the one the rest of carbon already uses. BufferedIo is the
// same seam pointed at an array, which is what lets the dispatcher tests
// assert on output without swapping globals.

import { log, c } from "@carbon/logging";
import type { Io } from "./io-port.ts";

export const consoleIo: Io = {
  c,
  info: (m) => log.info(m),
  step: (m) => log.step(m),
  success: (m) => log.success(m),
  warn: (m) => log.warn(m),
  error: (m) => log.error(m),
  raw: (m) => log.raw(m),
};

/** Collects output instead of printing it. For tests. */
export class BufferedIo implements Io {
  readonly c = c;
  readonly lines: string[] = [];

  info(m: string) { this.lines.push(m); }
  step(m: string) { this.lines.push(m); }
  success(m: string) { this.lines.push(m); }
  warn(m: string) { this.lines.push(m); }
  error(m: string) { this.lines.push(m); }
  raw(m: string) { this.lines.push(m); }

  get text(): string {
    return this.lines.join("\n");
  }
}
