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
  const shell = opts.shell ?? IS_WINDOWS;
  const prepared = shell && IS_WINDOWS ? prepareForShell(cmd, args) : { cmd, args };
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.cmd, prepared.args, {
      stdio: "inherit",
      shell,
      ...opts,
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
}

/** Spawns and returns the handle, so the caller can signal or kill it. */
export function start(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const shell = opts.shell ?? IS_WINDOWS;
  const prepared = shell && IS_WINDOWS ? prepareForShell(cmd, args) : { cmd, args };
  return spawn(prepared.cmd, prepared.args, {
    stdio: "inherit",
    shell,
    ...opts,
  });
}

/** The port implementation the composition root injects. */
export const nodeProcessRunner: ProcessRunner = {
  run: (command, args, options: ProcessOptions = {}) => run(command, args, options as SpawnOptions),
};
