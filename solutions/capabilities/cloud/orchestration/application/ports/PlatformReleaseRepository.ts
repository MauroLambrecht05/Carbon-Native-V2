import type {
  Channel, ChannelCommand, ChannelDetails, ChannelReceipt, EnvironmentScope, Release, ReleaseArtifact, ReleaseCreate, ReleaseReceipt, SigningProfile,
} from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

/** The key a signing profile points at: the secret that holds it and the public key recorded when the profile was made. */
export interface ProfileKey { readonly secretName: string; readonly publicKey: string }

/** What a release will be made from, checked and authorized, before any artifact is read or signed. */
export interface ReleasePlan {
  /** Set when this idempotency key already produced a release: return it and do nothing else. */
  readonly existing?: ReleaseReceipt;
  readonly key: ProfileKey;
  readonly artifacts: readonly Omit<ReleaseArtifact, 'signature' | 'url'>[];
}
export interface ReleaseCreation {
  readonly actor: OrganizationActor; readonly scope: EnvironmentScope; readonly id: string; readonly value: ReleaseCreate; readonly artifacts: readonly ReleaseArtifact[];
  readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}
export interface ReleaseWithdrawal {
  readonly actor: OrganizationActor; readonly scope: EnvironmentScope; readonly releaseId: string; readonly reason: string; readonly expectedRevision: string;
  readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}

/** What a channel revision will announce, checked and authorized, before the manifest is built and signed. */
export interface ChannelPlan {
  readonly existing?: ChannelReceipt;
  readonly release: Release;
  readonly rollout: number;
  readonly key: ProfileKey;
}
export interface ChannelRevisionWrite {
  readonly actor: OrganizationActor; readonly scope: EnvironmentScope; readonly name: string; readonly command: ChannelCommand; readonly releaseId: string; readonly rollout: number;
  /** The exact text that is served and the signature over its bytes. */
  readonly manifest: string; readonly signature: string; readonly feedId: string;
  /** "0" for a channel that does not exist yet. */
  readonly expectedRevision: string; readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}

export interface PlatformReleaseRepository {
  createProfile(actor: OrganizationActor, scope: EnvironmentScope, id: string, name: string, key: ProfileKey, requestId: string): Promise<SigningProfile>;
  profiles(actor: OrganizationActor, scope: EnvironmentScope): Promise<readonly SigningProfile[]>;
  /** Authorizes the caller to bind this secret as a signing key, before Cloud reads it. */
  authorizeSigning(actor: OrganizationActor, scope: EnvironmentScope): Promise<void>;

  planRelease(actor: OrganizationActor, scope: EnvironmentScope, value: ReleaseCreate, keyDigest: string, requestDigest: string): Promise<ReleasePlan>;
  createRelease(input: ReleaseCreation): Promise<ReleaseReceipt>;
  releases(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string): Promise<readonly Release[]>;
  release(actor: OrganizationActor, scope: EnvironmentScope, id: string): Promise<Release>;
  withdraw(input: ReleaseWithdrawal): Promise<ReleaseReceipt>;

  planChannel(actor: OrganizationActor, scope: EnvironmentScope, name: string, command: ChannelCommand, keyDigest: string, requestDigest: string): Promise<ChannelPlan>;
  revise(input: ChannelRevisionWrite): Promise<ChannelReceipt>;
  channels(actor: OrganizationActor, scope: EnvironmentScope): Promise<readonly Channel[]>;
  channel(actor: OrganizationActor, scope: EnvironmentScope, name: string): Promise<ChannelDetails>;

  /** The public feed. No caller identity: what is returned is what any installed app may read. */
  feed(feedId: string, channel: string): Promise<UpdateFeed | null>;
}

export interface UpdateFeed {
  /** Null when the channel currently offers nothing. */
  readonly manifest: { readonly text: string; readonly signature: string } | null;
  readonly withdrawn: readonly { readonly version: string; readonly reason: string; readonly withdrawnAt: string }[];
}

/**
 * Signs with the Ed25519 key held in an environment secret. The key is decrypted for the call and never returned,
 * stored or logged; callers get the signature and the public key it verifies under.
 */
export interface ReleaseSigner {
  publicKey(scope: EnvironmentScope, secretName: string): Promise<string>;
  sign(scope: EnvironmentScope, secretName: string, bytes: Uint8Array): Promise<{ readonly signature: string; readonly publicKey: string }>;
}

/** Reads a stored artifact so it can be signed. Null when the object is missing or larger than the limit. */
export interface ArtifactReader { read(objectKey: string, maximumBytes: number): Promise<Uint8Array | null> }
