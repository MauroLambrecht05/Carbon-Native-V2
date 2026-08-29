// @carbon/logging — reporting progress, behind a port.
//
// Vendor-neutral: the port is ours, the console adapter is the default, and a
// CI adapter emitting structured JSON would drop in beside it.

export type { Logger } from "./ports/Logger.ts";
export { log, c, MemoryLogger, setLogSink, type LogKind, type LogSink } from "./adapters/ConsoleLogger.ts";
