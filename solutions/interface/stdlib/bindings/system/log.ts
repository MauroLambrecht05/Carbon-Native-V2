// log — into the runtime's rolling log file, at a level and under a target.

declare const __cm_log: (level: string, target: string, message: string) => void;
declare const __cm_log_path: () => string;

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

function fmtLogArgs(args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(" ");
}

export const log = {
  trace: (...args: unknown[]) => __cm_log("trace", "app", fmtLogArgs(args)),
  debug: (...args: unknown[]) => __cm_log("debug", "app", fmtLogArgs(args)),
  info:  (...args: unknown[]) => __cm_log("info",  "app", fmtLogArgs(args)),
  warn:  (...args: unknown[]) => __cm_log("warn",  "app", fmtLogArgs(args)),
  error: (...args: unknown[]) => __cm_log("error", "app", fmtLogArgs(args)),
  /** Targeted variant — second message gets routed under a named
   *  category so log filters can split UI logs from network logs etc. */
  with: (target: string) => ({
    trace: (...args: unknown[]) => __cm_log("trace", target, fmtLogArgs(args)),
    debug: (...args: unknown[]) => __cm_log("debug", target, fmtLogArgs(args)),
    info:  (...args: unknown[]) => __cm_log("info",  target, fmtLogArgs(args)),
    warn:  (...args: unknown[]) => __cm_log("warn",  target, fmtLogArgs(args)),
    error: (...args: unknown[]) => __cm_log("error", target, fmtLogArgs(args)),
  }),
  /** Path to the rolling log file. Useful for "open log folder" UI. */
  path: (): string => __cm_log_path(),
};
