// node:child_process implementation of the ProcessRunner port.
//
// Used for subprocesses that print to the terminal directly — cargo build,
// bun build, the runtime itself — which is why stdio defaults to "inherit".

import { spawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../ports/ProcessRunner.ts";

export type SpawnResult = ProcessResult;

export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      // Resolves cargo.exe / bun.exe via PATHEXT on Windows.
      shell: process.platform === "win32",
      ...opts,
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
}

/** Spawns and returns the handle, so the caller can signal or kill it. */
export function start(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...opts,
  });
}

/** The port implementation the composition root injects. */
export const nodeProcessRunner: ProcessRunner = {
  run: (command, args, options: ProcessOptions = {}) => run(command, args, options as SpawnOptions),
};
