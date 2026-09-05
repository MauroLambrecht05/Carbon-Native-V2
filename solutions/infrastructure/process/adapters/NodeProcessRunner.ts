// node:child_process implementation of the ProcessRunner port.
//
// Used for subprocesses that print to the terminal directly — cargo build,
// bun build, the runtime itself — which is why stdio defaults to "inherit".

import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../ports/ProcessRunner.ts";

export type SpawnResult = ProcessResult;

const IS_WINDOWS = process.platform === "win32";

// `shell: true` below exists only so Windows can resolve `cargo`/`bun` (and
// anything else invoked by bare name) via PATHEXT. Node documents that once
// shell is enabled, it stops building the Windows argv vector for you and
// instead joins `cmd` and every `args` entry with plain spaces before handing
// the line to cmd.exe — unlike shell:false, nothing here quotes an argument
// that contains one. A project path with a space in it (e.g. "Thread IDE")
// silently truncates at the first space when cmd.exe re-tokenizes the line,
// which surfaced as a native tool reading a half-length path and failing with
// "the system cannot find the file specified" — not as an argument-count
// error, since the truncated remainder just vanishes rather than becoming a
// separate arg.

/**
 * True for an already-resolved absolute path (`C:\...`, `C:/...`, or a UNC
 * `\\server\share\...`) — the ONE case `shell: true` buys nothing, because
 * PATHEXT/PATH resolution (the entire reason it's on by default on Windows)
 * only matters for a bare name like "cargo". Measured directly spawning
 * carbon-mini.exe by its absolute path: `shell: true` added 30-80ms over
 * `shell: false` for the exact same launch (cmd.exe itself has to be
 * created and torn down as an extra process in between), on top of Node's
 * own documented shell:true footgun above — an absolute path already
 * bypasses PATHEXT entirely, so this is strictly a bug fix AND a speedup,
 * not a tradeoff.
 */
function isAbsolutePath(cmd: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(cmd) || cmd.startsWith("\\\\");
}
function quoteForWindowsShell(value: string): string {
  if (value === "") return '""';
  // cmd.exe's own metacharacters, not a shell-injection concern: these are
  // trusted internal paths and flags, quoted so cmd.exe's tokenizer treats
  // them as one token, not escaped against an adversarial value.
  if (!/[\s"&|<>^()%!]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function prepareForShell(cmd: string, args: string[]): { cmd: string; args: string[] } {
  return { cmd: quoteForWindowsShell(cmd), args: args.map(quoteForWindowsShell) };
}

export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<ProcessResult> {
  const shell = opts.shell ?? (IS_WINDOWS && !isAbsolutePath(cmd));
  const prepared = shell && IS_WINDOWS ? prepareForShell(cmd, args) : { cmd, args };
  // "pipe" means the caller wants the output captured (to summarize on
  // success, dump verbatim on failure) rather than streamed straight to the
  // terminal — see ensureNodeModules/ensureRuntime.
  const capture = opts.stdio === "pipe";
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.cmd, prepared.args, {
      stdio: "inherit",
      shell,
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout?.on("data", (d) => { stdout += d; });
      child.stderr?.on("data", (d) => { stderr += d; });
    }
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) =>
      resolve(capture ? { code: code ?? 0, signal, stdout, stderr } : { code: code ?? 0, signal }),
    );
  });
}

/** Spawns and returns the handle, so the caller can signal or kill it. */
export function start(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const shell = opts.shell ?? (IS_WINDOWS && !isAbsolutePath(cmd));
  const prepared = shell && IS_WINDOWS ? prepareForShell(cmd, args) : { cmd, args };
  return spawn(prepared.cmd, prepared.args, {
    stdio: "inherit",
    shell,
    ...opts,
  });
}

/** The exact line carbon-mini's mini.rs/run_loop.rs print (unconditionally,
 *  not gated behind CARBON_NO_TIMING) the FIRST time anything actually hits
 *  the screen — a frame-cache hit, or, on a miss, the real first paint.
 *  Still used by DaemonClient.ts, which watches for it over the daemon's
 *  named pipe (relayed from a Rust-spawned child, not a direct Node/Bun
 *  spawn — see this file's git history for why a direct-spawn equivalent
 *  here, `startAndWaitForWindowVisible`, was removed: on this machine, Bun's
 *  Windows `child_process.spawn` with ANY stdio stream set to `"pipe"`
 *  allocated a brand-new visible console window for the child, even with the
 *  other two streams left as `"inherit"` — confirmed directly (conhost.exe
 *  process count increased by one per `carbon run`). Plain `start()` below,
 *  fully inherited stdio, has no such issue; `carbon run`/`carbon dev` print
 *  "ready" immediately after spawn again, same as before that feature. */
export const WINDOW_VISIBLE_MARKER = "[carbon-mini] window-visible";

/** The port implementation the composition root injects. */
export const nodeProcessRunner: ProcessRunner = {
  run: (command, args, options: ProcessOptions = {}) => run(command, args, options as SpawnOptions),
};
