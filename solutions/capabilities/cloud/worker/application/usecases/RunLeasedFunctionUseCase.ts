// One function execution on a worker lease: claim, read exactly what to run,
// fetch the lease's secrets, run the code in a child process inside a workspace
// nothing else has used, erase the workspace, and report. A heartbeat keeps the
// lease and carries Cloud's cancellation back; once the lease is cancelled or
// lost the process is killed and nothing is reported.

import type { WorkerFunctionComplete, WorkerFunctionInput, WorkerLeaseOffer, WorkerSecretBinding } from "@carbon/contracts/platform";
import { LeaseLostError, type BuildWorkspace, type HeldBuildLease, type WorkspaceProvider } from "../ports/LeasedBuild.ts";
import { redactor } from "./RunLeasedBuildUseCase.ts";

/** What Cloud accepts as an execution's log. Longer text is cut and marked. */
const MAX_LOG_CHARACTERS = 65536;
const CUT = "\n[log truncated]\n";

export type LeasedFunctionOutcome = "idle" | "succeeded" | "failed" | "cancelled" | "lost";

export interface FunctionProtocol {
  claim(): Promise<WorkerLeaseOffer>;
  heartbeat(lease: HeldBuildLease): Promise<{ readonly cancelled: boolean }>;
  secrets(lease: HeldBuildLease): Promise<readonly WorkerSecretBinding[]>;
  functionInput(lease: HeldBuildLease): Promise<WorkerFunctionInput>;
  functionComplete(lease: HeldBuildLease, result: WorkerFunctionComplete): Promise<void>;
}

export interface FunctionRun {
  readonly code: string;
  readonly input: unknown;
  /** The lease's secrets by name. They are the function's environment, and exist for this run only. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** A workspace for this run alone. It is erased when the run ends. */
  readonly directory: string;
  /** Aborted when the lease is cancelled or lost: the run must stop. */
  readonly signal: AbortSignal;
}
/** What the function printed, bounded by the runner. Not yet redacted. */
export interface FunctionRunLogs { readonly text: string; readonly truncated: boolean }
/** Either the function's return value, or the category of what went wrong, and in both cases what it printed. */
export type FunctionRunResult = ({ readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly category: string }) & { readonly logs?: FunctionRunLogs };

/**
 * Removes the lease's secret values from what leaves the worker. A value is looked for as it is and as it appears
 * inside JSON text, so a secret a function returns or prints is replaced whether or not it needed escaping.
 */
export function secretRedactor(values: readonly string[]): (text: string) => string {
  const forms = new Set<string>();
  for (const value of values) { if (value.length < 4) continue; forms.add(value); forms.add(JSON.stringify(value).slice(1, -1)); }
  return redactor([...forms]);
}
export interface FunctionRunner { run(input: FunctionRun): Promise<FunctionRunResult> }

export class RunLeasedFunctionUseCase {
  constructor(private readonly protocol: FunctionProtocol, private readonly workspaces: WorkspaceProvider, private readonly runner: FunctionRunner, private readonly options: { readonly heartbeatMs?: number } = {}) {}

  async execute(): Promise<LeasedFunctionOutcome> {
    // Nothing is claimed until the machine is clean of the last run.
    await this.workspaces.reset();
    const offer = await this.protocol.claim();
    if (offer.state !== "leased") return "idle";
    if (offer.lease.purpose !== "function") throw new Error("This worker only runs functions");
    const lease: HeldBuildLease = { leaseId: offer.lease.id, leaseToken: offer.leaseToken };

    const stopping = new AbortController(); let ended: "cancelled" | "lost" | undefined;
    const stop = (reason: "cancelled" | "lost") => { ended ??= reason; stopping.abort(); };
    const heartbeat = setInterval(() => {
      this.protocol.heartbeat(lease).then(receipt => { if (receipt.cancelled) stop("cancelled"); }, error => { if (error instanceof LeaseLostError) stop("lost"); });
    }, this.options.heartbeatMs ?? offer.heartbeatSeconds * 1000);

    let workspace: BuildWorkspace | undefined;
    try {
      const input = await this.protocol.functionInput(lease);
      const bindings = offer.lease.secretNames.length ? await this.protocol.secrets(lease) : [];
      workspace = await this.workspaces.create(input.executionId, input.attempt);
      const redact = secretRedactor(bindings.map(binding => binding.value));
      const result = await this.runner.run({ code: input.code, input: input.input, secrets: Object.fromEntries(bindings.map(binding => [binding.name, binding.value])),
        timeoutMs: input.timeoutSeconds * 1000, directory: workspace.directory, signal: stopping.signal });
      // The code, its input and its secrets do not stay on this machine, whatever the outcome.
      const finished = workspace; workspace = undefined; let erased = true;
      await finished.erase().catch(() => { erased = false; });
      if (ended) return ended;
      // Logs and output are redacted here, before anything is sent: Cloud never holds a secret a function printed or returned.
      let logs: { text: string; truncated: boolean } | undefined;
      if (result.logs?.text) {
        const text = redact(result.logs.text); const cut = text.length > MAX_LOG_CHARACTERS;
        logs = { text: cut ? text.slice(0, MAX_LOG_CHARACTERS - CUT.length) + CUT : text, truncated: result.logs.truncated || cut };
      }
      let output: unknown = null; let outputValid = true;
      if (result.ok) { try { output = JSON.parse(redact(JSON.stringify(result.output ?? null))); } catch { outputValid = false; } }
      const report: WorkerFunctionComplete = !erased ? { outcome: "failed", errorCategory: "workspace.not_erased" }
        : result.ok && outputValid ? { outcome: "succeeded", output, ...(logs ? { logs } : {}) }
        : { outcome: "failed", errorCategory: !result.ok && /^[a-z][a-z0-9_.-]{0,99}$/.test(result.category) ? result.category : result.ok ? "function.output_invalid" : "worker.internal", ...(logs ? { logs } : {}) };
      await this.protocol.functionComplete(lease, report);
      return report.outcome === "succeeded" ? "succeeded" : "failed";
    } catch (error) {
      clearInterval(heartbeat);
      await workspace?.erase().catch(() => undefined);
      if (ended) return ended;
      if (error instanceof LeaseLostError) return "lost";
      try { await this.protocol.functionComplete(lease, { outcome: "failed", errorCategory: "worker.internal" }); } catch { return "lost"; }
      return "failed";
    } finally { clearInterval(heartbeat); }
  }
}
