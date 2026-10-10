// What a worker needs to run one leased build: Cloud's worker protocol, a
// pinned source checkout, a workspace that exists for exactly one attempt,
// and the pipeline that turns the checkout into installers. Artifacts go
// through the existing ArtifactUploader port.

import type { BuildArtifactDeclare, BuildSource, WorkerBuildComplete, WorkerBuildInput, WorkerLeaseOffer, WorkerSecretBinding } from "@carbon/contracts/platform";

export interface HeldBuildLease {
  readonly leaseId: string;
  readonly leaseToken: string;
}

/** Cloud no longer honours this lease: it was cancelled, expired, or given to another worker. */
export class LeaseLostError extends Error {
  constructor() { super("The build lease is no longer held"); }
}

/** A failure that belongs to the build. The category is what Cloud records; the message stays on the worker. */
export class BuildFailure extends Error {
  constructor(readonly category: string, message: string) { super(message); }
}

export interface BuildProtocol {
  claim(): Promise<WorkerLeaseOffer>;
  /** Extends the lease. `cancelled` means Cloud wants the work stopped. */
  heartbeat(lease: HeldBuildLease): Promise<{ readonly cancelled: boolean }>;
  input(lease: HeldBuildLease): Promise<WorkerBuildInput>;
  secrets(lease: HeldBuildLease): Promise<readonly WorkerSecretBinding[]>;
  appendLog(lease: HeldBuildLease, sequence: number, text: string): Promise<void>;
  declareArtifact(lease: HeldBuildLease, artifact: BuildArtifactDeclare): Promise<void>;
  complete(lease: HeldBuildLease, result: WorkerBuildComplete): Promise<void>;
}

export interface ToolVersion {
  readonly name: string;
  readonly version: string;
}

export interface SourceCheckout {
  /** Puts exactly this commit into the empty directory and reports the commit that is actually checked out. */
  checkout(repositoryUrl: string, commitSha: string, directory: string): Promise<{ readonly resolvedCommit: string; readonly tool: ToolVersion }>;
}

export interface BuildWorkspace {
  readonly directory: string;
  /** Removes everything. Rejects if anything is left behind. */
  erase(): Promise<void>;
}

export interface WorkspaceProvider {
  /** Removes whatever an earlier build or a crash left behind. Called before work is claimed. */
  reset(): Promise<void>;
  /** A new, empty directory used by this attempt only. */
  create(buildId: string, attempt: number): Promise<BuildWorkspace>;
}

export interface BuildRun {
  readonly source: BuildSource;
  /** The checked-out commit. */
  readonly sourceDirectory: string;
  /** Where installers go. Inside the workspace, outside the checkout. */
  readonly outputDirectory: string;
  /** A place for files the build needs but must not publish, such as a signing certificate. Erased with the workspace. */
  readonly scratchDirectory: string;
  /** The lease's secrets by name. They exist in memory and in the workspace for this attempt only. */
  readonly secrets: Readonly<Record<string, string>>;
  log(text: string): void;
  readonly signal: AbortSignal;
}

export interface BuildResult {
  readonly outputs: readonly { readonly target: string; readonly path: string }[];
  readonly tools: readonly ToolVersion[];
  /** SHA-256 of the project's build configuration, when it has one. */
  readonly configurationDigest: string | null;
}

export interface BuildPipeline {
  run(input: BuildRun): Promise<BuildResult>;
}
