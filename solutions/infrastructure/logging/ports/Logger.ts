// The Logger port.
//
// Everything that reports progress depends on this interface, not on a console
// or a colour library. The console implementation lives in
// infrastructure/console-logger.ts; a CI adapter emitting structured JSON, or a
// test adapter capturing lines, plugs in without touching a use case.

export interface Logger {
  info(message: string): void;
  step(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  raw(message: string): void;
}
