import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PlatformFault, parseComponent, type ChannelCommand, type ChannelDetails, type ChannelList, type ChannelReceipt, type CommandOptions, type EnvironmentScope, type PageRequest, type Release,
  type ReleaseArtifact, type ReleaseCommand, type ReleaseCreate, type ReleasePage, type ReleaseReceipt, type SigningProfile, type SigningProfileCreate, type SigningProfileList,
} from '@carbon/contracts/platform';
import { tokenDigest, type AccountAuthentication, type MessageProtector, type OrganizationActor, requestActor } from '@carbon/identity';
import { BuildUpdateManifestUseCase } from '@carbon/publishing';
import { canonicalizeManifest } from '@carbon/signing';
import { compareVersions } from '@carbon/updating';
import type { ArtifactReader, PlatformReleaseRepository, ProfileKey, ReleaseSigner, UpdateFeed } from '../ports/PlatformReleaseRepository.ts';

/** Ed25519 signs the whole message at once, so an artifact is held in memory while it is signed. */
export const MAX_SIGNED_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface ReleaseSettings {
  /** Where installed apps download artifacts from: the public address of the artifact bucket. */
  readonly artifactBaseUrl: string;
}

/**
 * The manifest a channel revision serves: built by the same code `carbon publish` uses, in the same byte order,
 * so every updater that verifies a locally published manifest verifies this one.
 */
export function channelManifest(release: Release, channel: string, rollout: number, publicKey: string): string {
  return canonicalizeManifest(new BuildUpdateManifestUseCase().execute({
    version: release.version, channel, rollout, pubkey: publicKey, notes: release.notes, minVersion: release.minVersion,
    // Platforms in a fixed order, so the same revision always serializes to the same bytes.
    platforms: Object.fromEntries([...release.artifacts].sort((a, b) => a.platform < b.platform ? -1 : 1).map(item => [item.platform, { signature: item.signature, url: item.url, sha256: item.sha256 }])),
    // The release's date, not today's: republishing or rolling out does not change what was released when.
    now: new Date(release.createdAt),
  }));
}

/** Developers publish releases from succeeded builds and move channels between them. */
export class AccountReleases {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: PlatformReleaseRepository, private readonly signer: ReleaseSigner, private readonly artifacts: ArtifactReader,
    private readonly cursors: MessageProtector, private readonly settings: ReleaseSettings) {}

  /** A browser session, or a device or personal credential acting as its account within what it was given. */
  private actor(token: string, csrf?: string): Promise<OrganizationActor> { return requestActor(this.auth, token, csrf, 'Sign in to manage releases'); }

  /** Signs and checks that the secret still holds the key the profile recorded. A rotated or replaced secret must not sign silently. */
  private async sign(scope: EnvironmentScope, key: ProfileKey, bytes: Uint8Array): Promise<string> {
    const signed = await this.signer.sign(scope, key.secretName, bytes);
    if (signed.publicKey !== key.publicKey) throw new PlatformFault('conflict', 'The signing secret no longer holds the key this signing profile was created with');
    return signed.signature;
  }

  // ── Signing profiles ─────────────────────────────────────────────────────

  /** Binds an environment secret as an update signing key. Only its public key is recorded. */
  async createProfile(token: string, csrf: string, input: EnvironmentScope, value: SigningProfileCreate, requestId: string): Promise<SigningProfile> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('SigningProfileCreate', value); parseComponent('Id', requestId);
    const actor = await this.actor(token, csrf);
    await this.repository.authorizeSigning(actor, scope);
    return this.repository.createProfile(actor, scope, randomUUID(), value.name, { secretName: value.secretName, publicKey: await this.signer.publicKey(scope, value.secretName) }, requestId);
  }
  async profiles(token: string, input: EnvironmentScope): Promise<SigningProfileList> {
    const scope = parseComponent('EnvironmentScope', input);
    return parseComponent('SigningProfileList', { items: await this.repository.profiles(await this.actor(token), scope) });
  }

  // ── Releases ─────────────────────────────────────────────────────────────

  /**
   * Publishes a release from a succeeded build. Cloud reads each chosen artifact back from storage, checks it still
   * matches the digest the build recorded, and signs those bytes. The release is immutable from then on.
   */
  async create(token: string, csrf: string, input: EnvironmentScope, value: ReleaseCreate, options: CommandOptions, requestId: string): Promise<ReleaseReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('ReleaseCreate', value); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (new Set(value.artifacts.map(item => item.platform)).size !== value.artifacts.length) throw new PlatformFault('validation', 'A release offers one artifact per platform');
    if (value.minVersion !== null && (compareVersions(value.minVersion, value.version) ?? 1) > 0) throw new PlatformFault('validation', 'The minimum version cannot be newer than the release');
    const actor = await this.actor(token, csrf); const keyDigest = tokenDigest(options.idempotencyKey); const requestDigest = tokenDigest(JSON.stringify({ scope, value }));
    const plan = await this.repository.planRelease(actor, scope, value, keyDigest, requestDigest);
    if (plan.existing) return plan.existing;
    const artifacts: ReleaseArtifact[] = [];
    for (const item of plan.artifacts) {
      if (item.sizeBytes > MAX_SIGNED_ARTIFACT_BYTES) throw new PlatformFault('validation', 'This artifact is too large to be signed for release');
      const bytes = await this.artifacts.read(item.objectKey, item.sizeBytes).catch(() => { throw new PlatformFault('unavailable', 'Artifact storage could not be reached'); });
      // What is signed is what the build verified. An object changed since then is not released.
      if (!bytes || bytes.byteLength !== item.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new PlatformFault('conflict', 'A build artifact is missing from storage or no longer matches its digest');
      artifacts.push({ ...item, signature: await this.sign(scope, plan.key, bytes), url: `${this.settings.artifactBaseUrl.replace(/\/+$/, '')}/${item.objectKey}` });
    }
    return this.repository.createRelease({ actor, scope, id: randomUUID(), value, artifacts, keyDigest, requestDigest, requestId });
  }

  async list(token: string, input: EnvironmentScope, query: PageRequest): Promise<ReleasePage> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('PageRequest', query);
    if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const context = `releases:${actor.sessionId}:${actor.permissionRevision}:${scope.environmentId}:${limit}`; let afterId: string | undefined;
    if (query.cursor) try { afterId = parseComponent('Id', JSON.parse(await this.cursors.open(query.cursor, context)).afterId); } catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    const rows = await this.repository.releases(actor, scope, limit + 1, afterId); const items = rows.slice(0, limit);
    return parseComponent('ReleasePage', { items, nextCursor: rows[limit] && items.length ? await this.cursors.seal(JSON.stringify({ afterId: items.at(-1)!.id }), context) : null });
  }
  async get(token: string, input: EnvironmentScope, releaseId: string): Promise<Release> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', releaseId);
    return this.repository.release(await this.actor(token), scope, releaseId);
  }

  /**
   * Withdraws a release: it joins the environment's stop list, no channel offers it any more, and every channel that
   * pointed at it moves back to the last release it offered that is still published. Installed copies are not
   * recalled; an updater that reads the stop list rolls back on its own.
   */
  async command(token: string, csrf: string, input: EnvironmentScope, releaseId: string, value: ReleaseCommand, options: CommandOptions, requestId: string): Promise<ReleaseReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', releaseId); parseComponent('ReleaseCommand', value); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required');
    return this.repository.withdraw({ actor: await this.actor(token, csrf), scope, releaseId, reason: value.reason, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ scope, releaseId, value, expectedRevision: options.expectedRevision })), requestId });
  }

  // ── Channels ─────────────────────────────────────────────────────────────

  async channels(token: string, input: EnvironmentScope): Promise<ChannelList> {
    const scope = parseComponent('EnvironmentScope', input);
    return parseComponent('ChannelList', { items: await this.repository.channels(await this.actor(token), scope) });
  }
  async channel(token: string, input: EnvironmentScope, name: string): Promise<ChannelDetails> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('ChannelName', name);
    return this.repository.channel(await this.actor(token), scope, name);
  }

  /**
   * Moves a channel: `publish` points it at a release (first publication, promotion from another channel, or moving
   * back), `rollout` changes the percentage of installs offered the current one. Either way the result is a new
   * immutable revision with its own signed manifest; no release and no earlier revision is touched.
   */
  async channelCommand(token: string, csrf: string, input: EnvironmentScope, name: string, value: ChannelCommand, options: CommandOptions, requestId: string): Promise<ChannelReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('ChannelName', name); parseComponent('ChannelCommand', value); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    const expectedRevision = options.expectedRevision ?? '0';
    const actor = await this.actor(token, csrf); const keyDigest = tokenDigest(options.idempotencyKey); const requestDigest = tokenDigest(JSON.stringify({ scope, name, value, expectedRevision }));
    const plan = await this.repository.planChannel(actor, scope, name, value, keyDigest, requestDigest);
    if (plan.existing) return plan.existing;
    const manifest = channelManifest(plan.release, name, plan.rollout, plan.key.publicKey);
    const signature = await this.sign(scope, plan.key, new TextEncoder().encode(manifest));
    return this.repository.revise({ actor, scope, name, command: value, releaseId: plan.release.id, rollout: plan.rollout, manifest, signature, feedId: randomBytes(16).toString('hex'),
      expectedRevision, keyDigest, requestDigest, requestId });
  }
}

/** What installed apps read. No session, no credential: the feed address is the only thing a caller needs. */
export class PublicUpdateFeed {
  constructor(private readonly repository: PlatformReleaseRepository) {}

  /** `file` is one of the three documents an updater fetches. Null means there is nothing at that address. */
  async read(feedId: string, channel: string, file: 'manifest.json' | 'manifest.sig' | 'yanked.json'): Promise<{ readonly body: string; readonly contentType: string } | null> {
    if (!/^[a-f0-9]{32}$/.test(feedId) || !/^[a-z][a-z0-9-]{0,31}$/.test(channel)) return null;
    const feed: UpdateFeed | null = await this.repository.feed(feedId, channel);
    if (!feed) return null;
    if (file === 'yanked.json') {
      // A stop list always exists for a live channel, even when empty, so "nothing withdrawn" is an answer and not an error.
      return { contentType: 'application/json', body: JSON.stringify({ yanked: feed.withdrawn.map(item => ({ version: item.version, reason: item.reason, yanked_at: item.withdrawnAt })),
        generated_at: feed.withdrawn.reduce((latest, item) => item.withdrawnAt > latest ? item.withdrawnAt : latest, '') }) };
    }
    if (!feed.manifest) return null;
    return file === 'manifest.json' ? { contentType: 'application/json', body: feed.manifest.text } : { contentType: 'text/plain', body: feed.manifest.signature };
  }
}
