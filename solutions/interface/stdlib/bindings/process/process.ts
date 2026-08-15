// process — spawning and driving child processes.
//
// Long-running interactions use the handle pattern: spawn() returns an id,
// then separate read/write/wait/kill ops drain it.

declare const __cm_proc_exec: (cmd: string, argsJson: string, cwd: string) => string;
declare const __cm_proc_spawn: (cmd: string, argsJson: string, cwd: string) => number;
declare const __cm_proc_write_stdin: (id: number, data: string) => number;
declare const __cm_proc_read_stdout: (id: number) => string;
declare const __cm_proc_read_stderr: (id: number) => string;
declare const __cm_proc_kill: (id: number) => void;
declare const __cm_proc_wait: (id: number) => number;
declare const __cm_proc_try_status: (id: number) => number;
declare const __cm_proc_pid_self: () => number;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SpawnOptions {
  cwd?: string;
}

export class ChildProcess {
  constructor(public readonly id: number) {}

  writeStdin(data: string): number {
    return __cm_proc_write_stdin(this.id, data);
  }
  readStdout(): string { return __cm_proc_read_stdout(this.id); }
  readStderr(): string { return __cm_proc_read_stderr(this.id); }
  /** Returns null while the child is still running; the exit code on completion. */
  tryStatus(): number | null {
    const s = __cm_proc_try_status(this.id);
    return s === -2 ? null : s;
  }
  kill(): void { __cm_proc_kill(this.id); }
  /** Blocks until the child exits and returns its exit code. */
  wait(): number { return __cm_proc_wait(this.id); }
}

export const process = {
  /** Runs `cmd args...` and blocks until it exits. */
  exec: (cmd: string, args: string[] = [], opts: SpawnOptions = {}): ExecResult => {
    return JSON.parse(__cm_proc_exec(cmd, JSON.stringify(args), opts.cwd ?? "")) as ExecResult;
  },
  /** Spawns `cmd args...` with piped stdio; returns a handle for streaming I/O. */
  spawn: (cmd: string, args: string[] = [], opts: SpawnOptions = {}): ChildProcess => {
    return new ChildProcess(__cm_proc_spawn(cmd, JSON.stringify(args), opts.cwd ?? ""));
  },
  pidSelf: (): number => __cm_proc_pid_self(),
};
