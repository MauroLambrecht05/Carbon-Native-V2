import type { Action, CommandOptions, Operation, Page, PageRequest, RequestContext, Result, Scope, Unsubscribe } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type WindowsFormat = "nsis" | "wix";
export type SignatureState = "not_configured" | "signed" | "invalid" | "expired" | "unknown";
export type BuildStatus = "queued" | "claimed" | "running" | "cancel_requested" | "cancelled" | "succeeded" | "failed";
export type StageName = "fetch" | "dependencies" | "bundle" | "package" | "sign" | "upload" | "finalize";
export type BuildSettings = Readonly<{
  projectId: string; revision: string; formats: readonly WindowsFormat[]; profile: "debug" | "release";
  toolchain: string; timeoutMinutes: number; maxAttempts: number; workerPool: "managed" | "organization";
  cacheGeneration: number; invalidateNext: boolean;
  manifest: { appId: string; name: string; version: string; digest: string; source: "repository" };
  configurationStatus: "synchronized" | "conflict";
}>;
export type SigningSettings = Readonly<{
  projectId: string; revision: string; requireSignedProduction: boolean;
  certificate: { state: SignatureState; subject?: string; expiresAt?: string; secretId?: string; secretVersion?: number };
  keys: readonly { id: string; publicKey: string; state: "active" | "overlap" | "revoked"; createdAt: string; overlapUntil?: string; crossSignedBy?: string; affectedReleaseIds?: readonly string[] }[];
  actions: { configure: Action; rotate: Action };
}>;
export type PluginSnapshot = Readonly<{ id: string; version: string; targetTriple: string; digest: string; trust: "verified" | "revoked" | "unknown"; compatible: boolean; grants: readonly string[] }>;
export type BuildInputs = Readonly<{
  repository: string; branch: string; commit: string; rootDirectory: string; repositoryRevision: string;
  manifest: BuildSettings["manifest"]; configurationRevision: string; toolchain: string;
  targetTriple: "x86_64-pc-windows-msvc"; formats: readonly WindowsFormat[]; profile: "debug" | "release";
  environmentId: string; secretRefs: readonly { id: string; version: number }[];
  signing: SigningSettings; plugins: readonly PluginSnapshot[]; dependencyRevision: string;
  cacheGeneration: number; cacheBypassed: boolean; workerPool: "managed" | "organization"; timeoutMinutes: number; maxAttempts: number;
}>;
export type BuildStage = Readonly<{ name: StageName; status: "pending" | "running" | "succeeded" | "failed" | "cancelled"; startedAt?: string; finishedAt?: string }>;
export type BuildAttempt = Readonly<{
  id: string; number: number; workerId?: string; leaseId?: string; leaseExpiresAt?: string;
  status: BuildStatus | "lease_expired"; stages: readonly BuildStage[]; startedAt?: string; finishedAt?: string; error?: string;
}>;
export type Build = Readonly<{
  id: string; scope: Scope; revision: string; actorId: string; trigger: "manual" | "push" | "pull_request" | "retry";
  deliveryId?: string; retryOf?: string; inputs: BuildInputs; status: BuildStatus; queuedAt: string; startedAt?: string; finishedAt?: string;
  operationId: string; attempts: readonly BuildAttempt[]; artifactIds: readonly string[];
  queueMs: number; runMs: number; error?: string; actions: { cancel: Action; retry: Action; draft: Action };
}>;
export type Artifact = Readonly<{
  id: string; buildId: string; scope: Scope; revision: string; targetTriple: string; format: WindowsFormat | "zip";
  payloadKind: "installer" | "full_update"; compatibility: "installer-only" | "carbon-polling-v1";
  name: string; size: number; digest: string; signature: SignatureState; keyId?: string;
  expiresAt: string; retention: "temporary" | "release_retained"; deletedAt?: string; releaseIds: readonly string[]; actions: { download: Action; remove: Action };
}>;
export type Preflight = Readonly<{ allowed: boolean; checks: readonly { name: string; state: "pass" | "warning" | "blocked"; detail: string }[]; inputs?: BuildInputs; revision: string }>;
export type BuildRequest = Readonly<{ environmentId: string; ref: string; formats: readonly WindowsFormat[]; confirmation?: string }>;
export type BuildFilter = PageRequest & { status?: string; branch?: string; actorId?: string; format?: string; environmentId?: string; after?: string; before?: string };
export type BuildLog = Readonly<{ sequence: number; attemptId: string; stage: StageName; stream: "stdout" | "stderr"; text: string; occurredAt: string }>;
export type LogRequest = Readonly<{ cursor?: string; stage?: string; stream?: string; search?: string; limit?: number }>;
export type LogPage = Readonly<{ items: readonly BuildLog[]; cursor: string; hasMore: boolean }>;
export type Download = Readonly<{ filename: string; contentType: string; bytes: readonly number[] }>;
export type Worker = Readonly<{
  id: string; orgId: string; name: string; revision: string; registration: "pending" | "registered" | "revoked";
  status: "online" | "paused" | "draining" | "offline"; formats: readonly WindowsFormat[]; toolchains: readonly string[];
  lastHeartbeat?: string; runningBuildId?: string; capacity: number; credentialPrefix: string;
  actions: Readonly<Record<"rotate" | "revoke" | "pause" | "drain" | "resume" | "remove", Action>>;
}>;
export type Capacity = Readonly<{ managedAvailable: number; organizationAvailable: number; queued: number; usedMinutes: number; reservedMinutes: number; limitMinutes: number }>;
export type Release = Readonly<{
  id: string; scope: Scope; revision: string; buildId: string; version: string; notes: string; environmentId: string;
  artifactIds: readonly string[]; sourceRevision: string; compatibility: "carbon-polling-v1" | "installer-only";
  migration: "compatible" | "forward_only" | "unknown"; targetChannelId: string;
  status: "draft" | "publishing" | "published" | "publish_failed" | "withdrawn"; publishedAt?: string;
  operationId?: string; manifest?: { digest: string; keyId: string; assets: readonly string[]; signature: SignatureState };
  withdrawal?: { reason: string; replacementPlan: string; at: string; metadataDigest: string };
  actions: { edit: Action; publish: Action; remove: Action; withdraw: Action };
}>;
export type Channel = Readonly<{
  id: string; projectId: string; name: string; revision: string; releaseId?: string; rollout: number; cohort: string;
  pausedAt?: string; status: "empty" | "active" | "paused";
  history: readonly { action: string; releaseId?: string; previousReleaseId?: string; rollout: number; at: string; actorId: string }[];
  observations: { status: "not_reported" | "simulated" | "offline" | "stale"; population: number | null; eligible: number | null; lastReportedAt?: string; detail: string };
  actions: { update: Action; pause: Action; resume: Action; rollback: Action };
}>;
export type DraftInput = Readonly<{ buildId: string; version: string; notes: string; artifactIds: readonly string[]; channelId: string; compatibility: Release["compatibility"]; migration: Release["migration"] }>;
export type ReleaseCommand =
  | { kind: "create"; input: DraftInput }
  | { kind: "edit"; releaseId: string; input: DraftInput }
  | { kind: "delete"; releaseId: string }
  | { kind: "publish"; releaseId: string; channelRevision: string; confirmation?: string }
  | { kind: "withdraw"; releaseId: string; reason: string; replacementPlan: string; confirmation: string };
export type ChannelCommand =
  | { kind: "create"; name: string }
  | { kind: "rollout"; channelId: string; percentage: number; confirmation?: string }
  | { kind: "pause" | "resume"; channelId: string; confirmation?: string }
  | { kind: "promote" | "rollback"; channelId: string; releaseId: string; confirmation?: string };
export type SigningCommand =
  | { kind: "certificate"; secretId: string; subject: string; expiresAt: string }
  | { kind: "disable-certificate" }
  | { kind: "rotate-key"; overlapDays: number; clientCompatibility: string }
  | { kind: "revoke-key"; keyId: string; confirmation: string };
export type WorkerCommand =
  | { kind: "enroll"; name: string; formats: readonly WindowsFormat[] }
  | { kind: "rotate" | "revoke" | "pause" | "drain" | "resume" | "remove"; workerId: string; confirmation?: string };

export interface DeliveryService {
  getBuildSettings(context: RequestContext): Promise<Result<BuildSettings>>;
  saveBuildSettings(context: RequestContext, input: Pick<BuildSettings, "formats" | "profile" | "toolchain" | "timeoutMinutes" | "maxAttempts" | "workerPool">, options: CommandOptions): Promise<Result<CommandReceipt>>;
  invalidateCache(context: RequestContext, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getBuildPreflight(context: RequestContext, input: BuildRequest): Promise<Result<Preflight>>;
  startBuild(context: RequestContext, input: BuildRequest, options: CommandOptions): Promise<Result<CommandReceipt>>;
  simulateRepositoryEvent(context: RequestContext, input: BuildRequest & { deliveryId: string; event: "push" | "pull_request" }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listBuilds(context: RequestContext, filter?: BuildFilter): Promise<Result<Page<Build>>>;
  getBuild(context: RequestContext, id: string): Promise<Result<Build>>;
  cancelBuild(context: RequestContext, id: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  retryBuild(context: RequestContext, id: string, latest: boolean, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  readLogs(context: RequestContext, id: string, request?: LogRequest): Promise<Result<LogPage>>;
  subscribeLogs(context: RequestContext, id: string, request: LogRequest, listener: (message: Result<LogPage>) => void): Promise<Result<Unsubscribe>>;
  exportLogs(context: RequestContext, id: string): Promise<Result<Download>>;
  listArtifacts(context: RequestContext, buildId: string, page?: PageRequest): Promise<Result<Page<Artifact>>>;
  downloadArtifact(context: RequestContext, id: string): Promise<Result<Download>>;
  removeArtifact(context: RequestContext, id: string, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getCapacity(context: RequestContext): Promise<Result<Capacity>>;
  listWorkers(context: RequestContext, page?: PageRequest): Promise<Result<Page<Worker>>>;
  workerCommand(context: RequestContext, input: WorkerCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getSigning(context: RequestContext): Promise<Result<SigningSettings>>;
  signingCommand(context: RequestContext, input: SigningCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listReleases(context: RequestContext, page?: PageRequest): Promise<Result<Page<Release>>>;
  getRelease(context: RequestContext, id: string): Promise<Result<Release>>;
  getReleasePreflight(context: RequestContext, id: string): Promise<Result<Preflight>>;
  releaseCommand(context: RequestContext, input: ReleaseCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listChannels(context: RequestContext, page?: PageRequest): Promise<Result<Page<Channel>>>;
  getChannel(context: RequestContext, id: string): Promise<Result<Channel>>;
  channelCommand(context: RequestContext, input: ChannelCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
}

export type DeliveryOperation = Operation & { kind: "windows.build" | "release.publish" };
