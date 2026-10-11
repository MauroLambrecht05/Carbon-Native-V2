// Runs one function in its own Bun process. The function is an ES module
// whose default export is called with the input; whatever it returns is the
// output. It never runs inside the worker's own process.
//
// The child gets an environment that contains the lease's secrets and the few
// variables a process needs to start, and nothing else from the worker: not
// the worker's credential, not the object-store keys.
//
// What the function prints, and the stack of an error it throws, are captured
// up to a fixed size and handed back with the result. Nothing is redacted
// here: the use case does that before anything leaves the worker.
//
// What this does NOT do: limit CPU, memory, disk or network, or run the code
// as another user. It bounds wall time, output size and log size only.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FunctionRun, FunctionRunResult, FunctionRunner } from "../application/usecases/RunLeasedFunctionUseCase.ts";

const MAX_OUTPUT_BYTES = 262144;
/** Bytes of standard output and error kept, together. The rest is read and dropped so the function never blocks on a full pipe. */
const MAX_LOG_BYTES = 60000;
/** Variables a child process needs to start on each platform. Nothing else is inherited. */
const INHERITED = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "HOME", "USERPROFILE", "LANG", "TZ"];

// Loads the function, calls its default export with the input from stdin, and writes the result to a file. The
// result does not go to stdout, so anything the function prints cannot be mistaken for it.
const HARNESS = `import { readFileSync, writeFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
let handler;
const say = error => { try { console.error(error instanceof Error && error.stack ? error.stack : String(error)); } catch {} };
try { handler = (await import("./function.mjs")).default; } catch (error) { say(error); process.exit(3); }
if (typeof handler !== "function") { say("The module's default export is not a function"); process.exit(3); }
let output;
try { output = await handler(input); } catch (error) { say(error); process.exit(4); }
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
    const child = Bun.spawn([this.executable, "harness.mjs"], { cwd: directory, env, stdin: new TextEncoder().encode(JSON.stringify(input.input ?? null)), stdout: "pipe", stderr: "pipe" });
    // Both streams into one bounded buffer, in the order their chunks arrive.
    const kept: Uint8Array[] = []; let size = 0; let truncated = false;
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) {
        const room = MAX_LOG_BYTES - size;
        if (room <= 0) { truncated = true; continue; }
        if (chunk.byteLength > room) { kept.push(chunk.subarray(0, room)); size += room; truncated = true; } else { kept.push(chunk); size += chunk.byteLength; }
      }
    };
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]).catch(() => { truncated = true; });
    const logs = async () => { await drained; return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(kept)), truncated }; };
    let timedOut = false; let stopped = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs);
    const abort = () => { stopped = true; child.kill("SIGKILL"); };
    input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
    let code: number;
    try { code = await child.exited; } finally { clearTimeout(timer); input.signal.removeEventListener("abort", abort); }
    if (stopped) return { ok: false, category: "function.stopped" };
    const printed = await logs();
    if (timedOut) return { ok: false, category: "function.timeout", logs: printed };
    if (code !== 0) return { ok: false, category: EXIT[code] ?? "function.crashed", logs: printed };
    const result = join(directory, "result.json");
    if (!existsSync(result)) return { ok: false, category: "function.crashed", logs: printed };
    if (statSync(result).size > MAX_OUTPUT_BYTES) return { ok: false, category: "function.output_too_large", logs: printed };
    try { return { ok: true, output: JSON.parse(readFileSync(result, "utf8")), logs: printed }; } catch { return { ok: false, category: "function.output_invalid", logs: printed }; }
  }
}
