// Builds, signing profiles, releases and update channels as Carbon Cloud
// really offers them. All four belong to one environment. The mock's delivery
// contract describes build configurations and promotion flows the service does
// not have; pages against the live service use this contract instead.

import type { CommandOptions, Page, PageRequest, RequestContext, Result } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type LiveBuild = Readonly<{
  id: string; state: "queued" | "running" | "succeeded" | "failed" | "cancelled"; repositoryUrl: string; commitSha: string; targets: readonly string[]; platform: string; secretNames: readonly string[];
  attempt: number; errorCategory: string | null; reservedMinutes: number; usedMinutes: number | null; revision: string; createdAt: string; startedAt: string | null; completedAt: string | null;
}>;
export type LiveBuildArtifact = Readonly<{ id: string; target: string; sizeBytes: number; sha256: string }>;
export type LiveBuildDetails = Readonly<{ build: LiveBuild; artifacts: readonly LiveBuildArtifact[] }>;
export type LiveBuildLog = Readonly<{ text: string; nextSequence: number | null }>;
export type LiveBuildCreate = Readonly<{ repositoryUrl: string; commitSha: string; targets: readonly string[]; platform: string; secretNames: readonly string[] }>;
export type LiveSigningProfile = Readonly<{ id: string; name: string; secretName: string; publicKey: string; createdAt: string }>;
export type LiveReleaseArtifact = Readonly<{ platform: string; target: string; sizeBytes: number; sha256: string; url: string }>;
export type LiveRelease = Readonly<{
  id: string; buildId: string; version: string; notes: string; minVersion: string | null; signingProfileId: string; state: "published" | "withdrawn"; artifacts: readonly LiveReleaseArtifact[];
  withdrawnReason: string | null; revision: string; createdAt: string; withdrawnAt: string | null;
}>;
export type LiveReleaseCreate = Readonly<{ buildId: string; version: string; notes: string; minVersion: string | null; signingProfileId: string; artifacts: readonly { platform: string; target: string }[] }>;
export type LiveChannelRevision = Readonly<{ number: number; releaseId: string; version: string; rollout: number; reason: string | null; createdAt: string }>;
export type LiveChannel = Readonly<{ name: string; feedUrl: string; current: LiveChannelRevision; revision: string }>;
export type LiveChannelDetails = Readonly<{ channel: LiveChannel; revisions: readonly LiveChannelRevision[] }>;
export type LiveChannelCommand = Readonly<{ kind: "publish"; releaseId: string; rollout: number } | { kind: "rollout"; rollout: number }>;

export interface LiveDeliveryService {
  builds(context: RequestContext, page?: PageRequest): Promise<Result<Page<LiveBuild>>>;
  build(context: RequestContext, id: string): Promise<Result<LiveBuildDetails>>;
  /** Log text after a sequence number. `nextSequence` is null when there is nothing further yet. */
  buildLog(context: RequestContext, id: string, after?: number): Promise<Result<LiveBuildLog>>;
  createBuild(context: RequestContext, input: LiveBuildCreate, options: CommandOptions): Promise<Result<CommandReceipt>>;
  cancelBuild(context: RequestContext, id: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  signingProfiles(context: RequestContext): Promise<Result<readonly LiveSigningProfile[]>>;
  createSigningProfile(context: RequestContext, input: { name: string; secretName: string }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  releases(context: RequestContext, page?: PageRequest): Promise<Result<Page<LiveRelease>>>;
  release(context: RequestContext, id: string): Promise<Result<LiveRelease>>;
  createRelease(context: RequestContext, input: LiveReleaseCreate, options: CommandOptions): Promise<Result<CommandReceipt>>;
  withdrawRelease(context: RequestContext, id: string, reason: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  channels(context: RequestContext): Promise<Result<readonly LiveChannel[]>>;
  channel(context: RequestContext, name: string): Promise<Result<LiveChannelDetails>>;
  /** A channel exists from its first publish. Publishing to a new name creates it and takes no revision. */
  channelCommand(context: RequestContext, name: string, command: LiveChannelCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
}
