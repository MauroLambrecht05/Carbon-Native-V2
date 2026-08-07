// The ProcessRunner port.
//
// Building a carbon app means shelling out — cargo, bun, code-signing tools.
// Use cases depend on this rather than on node:child_process, which is what
// makes "does the build pipeline call cargo with the right features" testable
// without a Rust toolchain installed.

export interface ProcessResult {
  readonly code: number;
  readonly signal: NodeJS.Signals | null;
}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdio?: "inherit" | "ignore" | "pipe";
}

export interface ProcessRunner {
  /** Runs to completion and resolves with the exit code. */
  run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>;
}
