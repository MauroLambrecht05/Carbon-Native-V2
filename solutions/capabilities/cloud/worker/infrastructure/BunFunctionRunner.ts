// Runs one function in its own Bun process. The function is an ES module
// whose default export is called with the input; whatever it returns is the
// output. It never runs inside the worker's own process.
//
// The child gets an environment that contains the lease's secrets and the few
// variables a process needs to start, and nothing else from the worker: not
// the worker's credential, not the object-store keys.
//
// What this does NOT do: limit CPU, memory, disk or network, or run the code
// as another user. It bounds wall time and output size only.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FunctionRun, FunctionRunResult, FunctionRunner } from "../application/usecases/RunLeasedFunctionUseCase.ts";

const MAX_OUTPUT_BYTES = 262144;
/** Variables a child process needs to start on each platform. Nothing else is inherited. */
const INHERITED = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "LANG", "TZ"];

// Loads the function, calls its default export with the input from stdin, and writes the result to a file. The
// result does not go to stdout, so anything the function prints cannot be mistaken for it.
const HARNESS = `import { readFileSync, writeFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
let handler;
try { handler = (await import("./function.mjs")).default; } catch { process.exit(3); }
if (typeof handler !== "function") process.exit(3);
let output;
try { output = await handler(input); } catch { process.exit(4); }
let text;
try { text = JSON.stringify(output === undefined ? null : output); } catch { process.exit(5); }
writeFileSync("./result.json", text);
process.exit(0);
`;
const EXIT: Record<number, string> = { 3: "function.invalid", 4: "function.threw", 5: "function.output_invalid" };

export class BunFunctionRunner implements FunctionRunner {
  /** `executable` is the bun binary functions run under; by default the one running the worker. */
  constructor(private readonly executable: string = process.execPath) {}

  async run(input: FunctionRun): Promise<FunctionRunResult> {
    // A directory of its own inside the workspace, holding the function and the harness and nothing else.
    const directory = join(input.directory, "function"); mkdirSync(directory);
    writeFileSync(join(directory, "function.mjs"), input.code); writeFileSync(join(directory, "harness.mjs"), HARNESS);
    const env: Record<string, string> = {};
    for (const name of INHERITED) { const value = process.env[name]; if (value !== undefined) env[name] = value; }
    // Secrets last: a secret may not be shadowed by anything inherited.
    Object.assign(env, { TMPDIR: directory, TEMP: directory, TMP: directory }, input.secrets);
    const child = Bun.spawn([this.executable, "harness.mjs"], { cwd: directory, env, stdin: new TextEncoder().encode(JSON.stringify(input.input ?? null)), stdout: "ignore", stderr: "ignore" });
    let timedOut = false; let stopped = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs);
    const abort = () => { stopped = true; child.kill("SIGKILL"); };
    input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
    let code: number;
    try { code = await child.exited; } finally { clearTimeout(timer); input.signal.removeEventListener("abort", abort); }
    if (stopped) return { ok: false, category: "function.stopped" };
    if (timedOut) return { ok: false, category: "function.timeout" };
    if (code !== 0) return { ok: false, category: EXIT[code] ?? "function.crashed" };
    const result = join(directory, "result.json");
    if (!existsSync(result)) return { ok: false, category: "function.crashed" };
    if (statSync(result).size > MAX_OUTPUT_BYTES) return { ok: false, category: "function.output_too_large" };
    try { return { ok: true, output: JSON.parse(readFileSync(result, "utf8")) }; } catch { return { ok: false, category: "function.output_invalid" }; }
  }
}
