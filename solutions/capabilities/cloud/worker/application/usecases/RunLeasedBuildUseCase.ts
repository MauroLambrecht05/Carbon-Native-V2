// One build, start to finish, on a worker lease: claim, read the immutable
// input, check out exactly that commit into a workspace nothing else has
// used, build, upload and declare the installers, erase the workspace, and
// only then report success. A heartbeat keeps the lease and carries Cloud's
// cancellation back; once the lease is cancelled or lost the work stops and
// nothing more is reported.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { BuildMaterials } from "@carbon/contracts/platform";
import type { ArtifactUploader } from "../ports/ArtifactUploader.ts";
import {
  BuildFailure, LeaseLostError, type BuildPipeline, type BuildProtocol, type BuildWorkspace, type HeldBuildLease, type SourceCheckout, type ToolVersion, type WorkspaceProvider,
} from "../ports/LeasedBuild.ts";

export type LeasedBuildOutcome = "idle" | "succeeded" | "failed" | "cancelled" | "lost";

export interface LeasedBuildOptions {
  /** Overrides the heartbeat interval Cloud asks for. */
  readonly heartbeatMs?: number;
  /** Values that must never reach a build log, beyond the lease's secrets: the worker's own credential, for one. */
  readonly redact?: readonly string[];
}

/** bun's lockfiles. A build without one would resolve dependency ranges at build time, so it is refused. */
const REQUIRED_LOCKS = ["bun.lock", "bun.lockb"];
/** Also part of the digest when present. */
const OTHER_LOCKS = ["Cargo.lock"];
// Far below the 65,536-character segment limit, so a segment of escaped control characters still fits the request limit.
const LOG_SEGMENT_CHARACTERS = 16000;

/**
 * SHA-256 over every dependency lockfile at the project root, by name. Returns null when no bun lockfile exists.
 * The bytes hashed are the checked-out bytes, so the checkout must not rewrite line endings.
 */
export function digestDependencyLocks(directory: string): string | null {
  if (!REQUIRED_LOCKS.some(name => existsSync(join(directory, name)))) return null;
  const hash = createHash("sha256");
  for (const name of [...REQUIRED_LOCKS, ...OTHER_LOCKS].sort()) {
    const path = join(directory, name); if (!existsSync(path)) continue;
    hash.update(`${name}\0${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

/** Replaces every protected value, and every line of a multi-line one, so a key printed line by line is still removed. */
export function redactor(values: readonly string[]): (text: string) => string {
  const needles = new Set<string>();
  for (const value of values) {
    if (!value) continue; needles.add(value);
    const lines = value.split(/\r?\n/); if (lines.length > 1) for (const line of lines) if (line.length >= 8) needles.add(line);
  }
  // Longest first, so a value that contains another is removed whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return text => { for (const needle of ordered) text = text.split(needle).join("[redacted]"); return text; };
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Sends log text to Cloud in order. Text is redacted before it leaves the worker. */
class BuildLog {
  private pending = ""; private sending: Promise<void> = Promise.resolve(); private failure: unknown;
  constructor(private readonly protocol: BuildProtocol, private readonly lease: HeldBuildLease, private sequence: number, private readonly redact: (text: string) => string) {}

  write(text: string): void { this.pending += text.endsWith("\n") ? text : `${text}\n`; }

  /** Sends everything written so far. Whole text is redacted at once, so a value split across writes is still caught. */
  flush(): Promise<void> {
    const text = this.redact(this.pending); this.pending = "";
    for (let offset = 0; offset < text.length; offset += LOG_SEGMENT_CHARACTERS) {
      const segment = text.slice(offset, offset + LOG_SEGMENT_CHARACTERS); const sequence = this.sequence++;
      this.sending = this.sending.then(() => this.failure ? undefined : this.protocol.appendLog(this.lease, sequence, segment)).catch(error => { this.failure ??= error; });
    }
    return this.sending.then(() => { if (this.failure) throw this.failure; });
  }
}

export class RunLeasedBuildUseCase {
  constructor(
    private readonly protocol: BuildProtocol,
    private readonly source: SourceCheckout,
    private readonly workspaces: WorkspaceProvider,
    private readonly pipeline: BuildPipeline,
    private readonly uploader: ArtifactUploader,
    private readonly options: LeasedBuildOptions = {},
  ) {}

  async execute(): Promise<LeasedBuildOutcome> {
    // Nothing is claimed until the machine is clean: a worker that cannot erase the last build must not start the next.
    await this.workspaces.reset();
    const offer = await this.protocol.claim();
    if (offer.state !== "leased") return "idle";
    if (offer.lease.purpose !== "build") throw new Error("This worker only runs builds");
    const lease: HeldBuildLease = { leaseId: offer.lease.id, leaseToken: offer.leaseToken };

    const stopping = new AbortController(); let ended: "cancelled" | "lost" | undefined;
    const stop = (reason: "cancelled" | "lost") => { ended ??= reason; stopping.abort(); };
    const proceed = () => { if (stopping.signal.aborted) throw new LeaseLostError(); };
    const heartbeat = setInterval(() => {
      // A heartbeat that could not be delivered is not a verdict; the next one, or the lease's own expiry, decides.
      this.protocol.heartbeat(lease).then(receipt => { if (receipt.cancelled) stop("cancelled"); }, error => { if (error instanceof LeaseLostError) stop("lost"); });
    }, this.options.heartbeatMs ?? offer.heartbeatSeconds * 1000);

    let workspace: BuildWorkspace | undefined; let log: BuildLog | undefined;
    try {
      const input = await this.protocol.input(lease); proceed();
      const bindings = offer.lease.secretNames.length ? await this.protocol.secrets(lease) : []; proceed();
      log = new BuildLog(this.protocol, lease, input.nextLogSequence, redactor([...bindings.map(binding => binding.value), lease.leaseToken, ...(this.options.redact ?? [])]));
      workspace = await this.workspaces.create(input.buildId, input.attempt);
      const sourceDirectory = join(workspace.directory, "source"); const outputDirectory = join(workspace.directory, "out"); const scratchDirectory = join(workspace.directory, "scratch");

      log.write(`Attempt ${input.attempt}: checking out ${input.source.commitSha}`); await log.flush();
      let checkedOut: { readonly resolvedCommit: string; readonly tool: ToolVersion };
      try { checkedOut = await this.source.checkout(input.source.repositoryUrl, input.source.commitSha, sourceDirectory); }
      catch (error) { throw error instanceof BuildFailure ? error : new BuildFailure("source.unavailable", String(error)); }
      proceed();
      // The input names a commit, not a branch: anything else on disk is not what was asked for.
      if (checkedOut.resolvedCommit !== input.source.commitSha) throw new BuildFailure("source.commit_mismatch", "The checked-out commit is not the requested commit");
      const dependencyLockDigest = digestDependencyLocks(sourceDirectory);
      if (!dependencyLockDigest) throw new BuildFailure("dependencies.unlocked", "The project has no dependency lockfile");

      log.write(`Building ${input.source.targets.join(", ")}`); await log.flush();
      const built = await this.pipeline.run({ source: input.source, sourceDirectory, outputDirectory, scratchDirectory,
        secrets: Object.fromEntries(bindings.map(binding => [binding.name, binding.value])), log: text => log!.write(text), signal: stopping.signal })
        .catch(error => { throw error instanceof BuildFailure || error instanceof LeaseLostError ? error : new BuildFailure("build.failed", String(error)); });
      proceed(); await log.flush();

      for (const target of input.source.targets) {
        const output = built.outputs.find(item => item.target === target);
        if (!output) throw new BuildFailure("package.missing_output", `No installer was produced for ${target}`);
        const path = resolve(output.path);
        // Only files this attempt wrote in its own workspace are publishable.
        if (!path.startsWith(resolve(workspace.directory) + sep)) throw new BuildFailure("package.outside_workspace", "An installer was produced outside the workspace");
        if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size < 1) throw new BuildFailure("package.missing_output", `The installer for ${target} is missing or empty`);
        const sizeBytes = statSync(path).size; const sha256 = await fileDigest(path);
        const name = basename(path).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[^A-Za-z0-9]+/, "") || "installer";
        const objectKey = `artifacts/${input.buildId}/${input.attempt}/${target}/${name}`;
        await this.uploader.upload(path, objectKey).catch(error => { throw new BuildFailure("artifact.upload_failed", String(error)); });
        proceed();
        await this.protocol.declareArtifact(lease, { target, objectKey, sizeBytes, sha256 });
        log.write(`Uploaded ${target}: ${sizeBytes} bytes, sha256 ${sha256}`);
      }

      // Success is only reported once nothing of this build is left on the machine.
      const finished = workspace; workspace = undefined;
      await finished.erase().catch(error => { throw new BuildFailure("workspace.not_erased", String(error)); });
      log.write("Workspace erased"); await log.flush(); proceed();
      const tools = new Map<string, ToolVersion>(); for (const tool of [checkedOut.tool, ...built.tools]) tools.set(tool.name, tool);
      const materials: BuildMaterials = { resolvedCommit: checkedOut.resolvedCommit, dependencyLockDigest, configurationDigest: built.configurationDigest,
        tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)), workspaceErased: true };
      // Cloud reads every artifact back before it accepts this; a refusal is the build's failure, not a lost lease.
      await this.protocol.complete(lease, { outcome: "succeeded", materials }).catch(error => { throw error instanceof LeaseLostError ? error : new BuildFailure("completion.rejected", String(error)); });
      return "succeeded";
    } catch (error) {
      clearInterval(heartbeat);
      // Whatever happened, the source, the secrets and the outputs do not stay on this machine. reset() retries before the next claim.
      await workspace?.erase().catch(() => undefined);
      if (ended) return ended;
      if (error instanceof LeaseLostError) return "lost";
      const category = error instanceof BuildFailure && /^[a-z][a-z0-9_.-]{0,99}$/.test(error.category) ? error.category : "worker.internal";
      try {
        if (log) { log.write(`Build failed: ${category}`); await log.flush(); }
        await this.protocol.complete(lease, { outcome: "failed", errorCategory: category });
      } catch { return "lost"; }
      return "failed";
    } finally { clearInterval(heartbeat); }
  }
}
