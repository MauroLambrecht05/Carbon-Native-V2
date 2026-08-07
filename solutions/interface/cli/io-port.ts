// The Io port.
//
// Commands write through this rather than calling console directly, so a test
// can capture what a command printed without swapping globals.

import type { c as colours } from "@carbon/logging";

export interface Io {
  readonly c: typeof colours;
  info(message: string): void;
  step(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  raw(message: string): void;
}
