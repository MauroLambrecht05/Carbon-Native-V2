import { createHash, randomUUID } from 'node:crypto';
import {
  PlatformFault, parseComponent, type Channel, type ChannelCommand, type ChannelRevision, type EnvironmentScope, type Release, type ReleaseCreate, type SigningProfile,
} from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import type {
  ChannelPlan, ChannelRevisionWrite, PlatformReleaseRepository, ProfileKey, ReleaseCreation, ReleasePlan, ReleaseWithdrawal, UpdateFeed,
} from '../application/ports/PlatformReleaseRepository.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
type Permission = 'metadata.read' | 'release.publish' | 'signing.manage';
const MAX_PROFILES = 20;
const MAX_CHANNELS = 50;
const DENIED: Record<Permission, string> = { 'metadata.read': 'Reading releases is not permitted', 'release.publish': 'Publishing releases is not permitted', 'signing.manage': 'Managing signing keys is not permitted' };

function scopeOf(row: Row): EnvironmentScope { return { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id }; }
function profile(row: Row): SigningProfile {
  return parseComponent('SigningProfile', { id: row.id, scope: scopeOf(row), name: row.name, secretName: row.secret_name, publicKey: row.public_key, createdBy: row.created_by, createdAt: row.created_at.toISOString() });
}
function revision(row: Row): ChannelRevision {
  return parseComponent('ChannelRevision', { number: row.number, releaseId: row.release_id ?? null, version: row.version ?? null, rollout: row.rollout, reason: row.reason, manifestDigest: row.manifest_digest ?? null,
    createdBy: row.created_by, createdAt: row.created_at.toISOString() });
}

export class PostgresPlatformReleaseRepository extends PostgresPlatformAuthority implements PlatformReleaseRepository {
  /** `origin` is Cloud's public origin: update feed addresses are built from it. */
  constructor(sql: Bun.SQL, private readonly origin: string) { super(sql); }

  private async authorize(tx: Tx, input: OrganizationActor, scope: EnvironmentScope, permission: Permission) {
    await this.lockAccounts(tx, [input.accountId], true); const current = await this.actor(tx, input);
    const actor = { ...input, permissionRevision: current.permission_revision as string };
    const access = await this.resolveInTransaction(tx, actor, scope);
    if (!access.permissions.includes(permission)) throw new PlatformFault('forbidden', DENIED[permission]);
    return actor;
  }
  private event(tx: Tx, scope: EnvironmentScope, kind: 'release' | 'channel' | 'signing_profile', resourceId: string, accountId: string, action: string, revisionNumber: string | number, requestId: string) {
    return tx`INSERT INTO release_events (id, org_id, project_id, environment_id, resource_kind, resource_id, actor_account_id, action, revision, request_id)
      VALUES (${randomUUID()}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${kind}, ${resourceId}, ${accountId}, ${action}, ${revisionNumber}, ${requestId})`;
  }
  private async replay<T>(tx: Tx, accountId: string, key: string, keyDigest: string, requestDigest: string, parse: (value: unknown) => T): Promise<T | undefined> {
    const old = (await tx`SELECT request_digest, result FROM release_commands WHERE actor_account_id = ${accountId} AND scope_key = ${key} AND key_digest = ${keyDigest}`)[0];
    if (!old) return undefined;
    if (old.request_digest !== requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command');
    return parse(old.result);
  }
  private remember(tx: Tx, accountId: string, key: string, keyDigest: string, requestDigest: string, receipt: unknown) {
    return tx`INSERT INTO release_commands VALUES (${accountId}, ${key}, ${keyDigest}, ${requestDigest}, ${JSON.stringify(receipt)}::text::jsonb, now())`;
  }
  private async toRelease(tx: Tx, row: Row): Promise<Release> {
    const artifacts = await tx<Row[]>`SELECT * FROM release_artifacts WHERE release_id = ${row.id} ORDER BY platform`;
    return parseComponent('Release', { id: row.id, scope: scopeOf(row), buildId: row.build_id, version: row.version, notes: row.notes, minVersion: row.min_version ?? null, signingProfileId: row.signing_profile_id,
      state: row.state, artifacts: artifacts.map(item => ({ platform: item.platform, target: item.target, objectKey: item.object_key, sizeBytes: Number(item.size_bytes), sha256: item.sha256, signature: item.signature, url: item.url })),
      withdrawnReason: row.withdrawn_reason ?? null, createdBy: row.created_by, revision: row.revision, createdAt: row.created_at.toISOString(), withdrawnAt: row.withdrawn_at?.toISOString() ?? null });
  }
  private async releaseRow(tx: Tx, scope: EnvironmentScope, id: string, lock = false): Promise<Row> {
    const rows = lock
      ? await tx<Row[]>`SELECT *, revision::text FROM releases WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} FOR UPDATE`
      : await tx<Row[]>`SELECT *, revision::text FROM releases WHERE id = ${id} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}`;
    if (!rows.length) throw new PlatformFault('not_found', 'Release not found');
    return rows[0]!;
  }
  private async keyOf(tx: Tx, scope: EnvironmentScope, profileId: string): Promise<ProfileKey> {
    const row = (await tx<Row[]>`SELECT secret_name, public_key FROM signing_profiles WHERE id = ${profileId} AND environment_id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId}`)[0];
    if (!row) throw new PlatformFault('validation', 'The signing profile does not belong to this environment');
    return { secretName: row.secret_name, publicKey: row.public_key };
  }

  // ── Signing profiles ─────────────────────────────────────────────────────

  async authorizeSigning(input: OrganizationActor, scope: EnvironmentScope) { await this.sql.begin(tx => this.authorize(tx, input, scope, 'signing.manage')); }

  async createProfile(input: OrganizationActor, scope: EnvironmentScope, id: string, name: string, key: ProfileKey, requestId: string) {
    try {
      return await this.sql.begin(async tx => {
        const actor = await this.authorize(tx, input, scope, 'signing.manage');
        await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
        if ((await tx`SELECT 1 FROM signing_profiles WHERE environment_id = ${scope.environmentId}`).length >= MAX_PROFILES) throw new PlatformFault('quota', 'This environment has reached its signing profile limit');
        const row = (await tx<Row[]>`INSERT INTO signing_profiles (id, org_id, project_id, environment_id, name, secret_name, public_key, created_by)
          VALUES (${id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${name}, ${key.secretName}, ${key.publicKey}, ${actor.accountId}) RETURNING *`)[0]!;
        await this.event(tx, scope, 'signing_profile', row.id, actor.accountId, 'signing_profile.created', 1, requestId);
        return profile(row);
      });
    } catch (error) {
      if ((error as { errno?: string }).errno === '23505') throw new PlatformFault('conflict', 'A signing profile with this name already exists');
      throw error;
    }
  }

  async profiles(input: OrganizationActor, scope: EnvironmentScope) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      return (await tx<Row[]>`SELECT * FROM signing_profiles WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} ORDER BY name`).map(profile);
    });
  }

  // ── Releases ─────────────────────────────────────────────────────────────

  /** A release offers only artifacts of a succeeded build in the same environment: the ones Cloud verified in storage. */
  private async chosen(tx: Tx, scope: EnvironmentScope, value: ReleaseCreate) {
    const build = (await tx<Row[]>`SELECT id, state FROM platform_builds WHERE id = ${value.buildId} AND org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}`)[0];
    if (!build) throw new PlatformFault('validation', 'The build does not belong to this environment');
    if (build.state !== 'succeeded') throw new PlatformFault('conflict', 'Only a succeeded build can be released');
    const rows = await tx<Row[]>`SELECT f.target, f.object_key, f.size_bytes, f.sha256 FROM build_artifacts f JOIN build_attempts a ON a.id = f.attempt_id WHERE f.build_id = ${build.id} AND a.state = 'succeeded'`;
    return value.artifacts.map(item => {
      const found = rows.find(row => row.target === item.target);
      if (!found) throw new PlatformFault('validation', 'The build did not produce that target');
      return { platform: item.platform, target: item.target, objectKey: found.object_key as string, sizeBytes: Number(found.size_bytes), sha256: found.sha256 as string };
    });
  }

  async planRelease(input: OrganizationActor, scope: EnvironmentScope, value: ReleaseCreate, keyDigest: string, requestDigest: string): Promise<ReleasePlan> {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'release.publish');
      const key = await this.keyOf(tx, scope, value.signingProfileId); const artifacts = await this.chosen(tx, scope, value);
      const existing = await this.replay(tx, actor.accountId, `releases:${scope.environmentId}`, keyDigest, requestDigest, result => parseComponent('ReleaseReceipt', result));
      if (existing) return { existing, key, artifacts };
      if ((await tx`SELECT 1 FROM releases WHERE environment_id = ${scope.environmentId} AND version = ${value.version}`).length) throw new PlatformFault('conflict', 'This version was already released in this environment');
      return { key, artifacts };
    });
  }

  async createRelease(input: ReleaseCreation) {
    try {
      return await this.sql.begin(async tx => {
        const { scope, value } = input; const actor = await this.authorize(tx, input.actor, scope, 'release.publish');
        const scopeKey = `releases:${scope.environmentId}`;
        const existing = await this.replay(tx, actor.accountId, scopeKey, input.keyDigest, input.requestDigest, result => parseComponent('ReleaseReceipt', result));
        if (existing) return existing;
        // Checked again here: the plan was made in an earlier transaction.
        await this.keyOf(tx, scope, value.signingProfileId); const chosen = await this.chosen(tx, scope, value);
        for (const item of chosen) {
          const signed = input.artifacts.find(artifact => artifact.platform === item.platform);
          if (!signed || signed.objectKey !== item.objectKey || signed.sha256 !== item.sha256 || signed.sizeBytes !== item.sizeBytes) throw new PlatformFault('conflict', 'The build changed; retry the release');
        }
        const row = (await tx<Row[]>`INSERT INTO releases (id, org_id, project_id, environment_id, build_id, version, notes, min_version, signing_profile_id, created_by, request_id)
          VALUES (${input.id}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${value.buildId}, ${value.version}, ${value.notes}, ${value.minVersion}, ${value.signingProfileId}, ${actor.accountId}, ${input.requestId})
          RETURNING *, revision::text`)[0]!;
        for (const item of input.artifacts) {
          await tx`INSERT INTO release_artifacts (release_id, platform, target, object_key, size_bytes, sha256, signature, url)
            VALUES (${row.id}, ${item.platform}, ${item.target}, ${item.objectKey}, ${item.sizeBytes}, ${item.sha256}, ${item.signature}, ${item.url})`;
        }
        const receipt = parseComponent('ReleaseReceipt', { release: await this.toRelease(tx, row), message: 'Release published' });
        await this.remember(tx, actor.accountId, scopeKey, input.keyDigest, input.requestDigest, receipt);
        await this.event(tx, scope, 'release', row.id, actor.accountId, 'release.published', row.revision, input.requestId);
        return receipt;
      });
    } catch (error) {
      if (error instanceof PlatformFault) throw error;
      if ((error as { errno?: string }).errno === '23505') throw new PlatformFault('conflict', 'This version was already released in this environment');
      throw error;
    }
  }

  async releases(input: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      const rows = await tx<Row[]>`SELECT *, revision::text FROM releases WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
        AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid) ORDER BY id LIMIT ${limit}`;
      const items: Release[] = []; for (const row of rows) items.push(await this.toRelease(tx, row));
      return items;
    });
  }

  async release(input: OrganizationActor, scope: EnvironmentScope, id: string) {
    return this.sql.begin(async tx => { await this.authorize(tx, input, scope, 'metadata.read'); return this.toRelease(tx, await this.releaseRow(tx, scope, id)); });
  }

  async withdraw(input: ReleaseWithdrawal) {
    return this.sql.begin(async tx => {
      const { scope } = input; const actor = await this.authorize(tx, input.actor, scope, 'release.publish');
      // Channels of one environment change one command at a time: a withdrawal and a publish cannot interleave.
      await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
      const row = await this.releaseRow(tx, scope, input.releaseId, true); const scopeKey = `release:${row.id}`;
      const existing = await this.replay(tx, actor.accountId, scopeKey, input.keyDigest, input.requestDigest, result => parseComponent('ReleaseReceipt', result));
      if (existing) return existing;
      if (row.revision !== input.expectedRevision) throw new PlatformFault('conflict', 'The release changed; refresh before retrying');
      if (row.state !== 'published') throw new PlatformFault('conflict', 'This release is already withdrawn');
      const updated = (await tx<Row[]>`UPDATE releases SET state = 'withdrawn', withdrawn_reason = ${input.reason}, withdrawn_at = now(), revision = revision + 1 WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      // Every channel offering it stops, in the same transaction: there is no moment when it is withdrawn and still offered.
      const offering = await tx<Row[]>`SELECT c.name, c.current_revision FROM channels c JOIN channel_revisions r ON r.environment_id = c.environment_id AND r.channel = c.name AND r.number = c.current_revision
        WHERE c.environment_id = ${scope.environmentId} AND r.release_id = ${row.id} ORDER BY c.name FOR UPDATE OF c`;
      for (const channel of offering) {
        // Back to the last release this channel offered that is still published, with the manifest that was signed for it then.
        const previous = (await tx<Row[]>`SELECT r.release_id, r.rollout, r.manifest, r.manifest_signature, r.manifest_digest FROM channel_revisions r JOIN releases l ON l.id = r.release_id
          WHERE r.environment_id = ${scope.environmentId} AND r.channel = ${channel.name} AND r.number < ${channel.current_revision} AND l.state = 'published' ORDER BY r.number DESC LIMIT 1`)[0];
        const next = channel.current_revision + 1;
        await tx`INSERT INTO channel_revisions (environment_id, channel, number, release_id, rollout, reason, manifest, manifest_signature, manifest_digest, created_by, request_id)
          VALUES (${scope.environmentId}, ${channel.name}, ${next}, ${previous?.release_id ?? null}, ${previous?.rollout ?? 0}, 'withdrawal', ${previous?.manifest ?? null}, ${previous?.manifest_signature ?? null},
            ${previous?.manifest_digest ?? null}, ${actor.accountId}, ${input.requestId})`;
        const moved = (await tx<Row[]>`UPDATE channels SET current_revision = ${next}, revision = revision + 1 WHERE environment_id = ${scope.environmentId} AND name = ${channel.name} RETURNING revision::text`)[0]!;
        await this.event(tx, scope, 'channel', scope.environmentId, actor.accountId, 'channel.withdrawn', moved.revision, input.requestId);
      }
      const receipt = parseComponent('ReleaseReceipt', { release: await this.toRelease(tx, updated), message: 'Release withdrawn' });
      await this.remember(tx, actor.accountId, scopeKey, input.keyDigest, input.requestDigest, receipt);
      await this.event(tx, scope, 'release', row.id, actor.accountId, 'release.withdrawn', updated.revision, input.requestId);
      return receipt;
    });
  }

  // ── Channels ─────────────────────────────────────────────────────────────

  private async toChannel(tx: Tx, row: Row): Promise<Channel> {
    const current = (await tx<Row[]>`SELECT r.*, l.version FROM channel_revisions r LEFT JOIN releases l ON l.id = r.release_id WHERE r.environment_id = ${row.environment_id} AND r.channel = ${row.name} AND r.number = ${row.current_revision}`)[0]!;
    const feed = (await tx<Row[]>`SELECT public_id FROM update_feeds WHERE environment_id = ${row.environment_id}`)[0]!;
    return parseComponent('Channel', { name: row.name, scope: scopeOf(row), feedUrl: `${this.origin.replace(/\/+$/, '')}/updates/v1/${feed.public_id}/${row.name}`, current: revision(current), revision: row.revision });
  }
  private channelRow(tx: Tx, scope: EnvironmentScope, name: string) {
    return tx<Row[]>`SELECT *, revision::text FROM channels WHERE environment_id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} AND name = ${name}`;
  }
  /** The release a command points the channel at: the named one for a publish, the current one for a rollout change. */
  private async target(tx: Tx, scope: EnvironmentScope, name: string, command: ChannelCommand): Promise<Row> {
    if (command.kind === 'publish') return this.releaseRow(tx, scope, command.releaseId);
    const current = (await tx<Row[]>`SELECT r.release_id FROM channels c JOIN channel_revisions r ON r.environment_id = c.environment_id AND r.channel = c.name AND r.number = c.current_revision
      WHERE c.environment_id = ${scope.environmentId} AND c.project_id = ${scope.projectId} AND c.org_id = ${scope.orgId} AND c.name = ${name}`)[0];
    if (!current) throw new PlatformFault('not_found', 'Channel not found');
    if (!current.release_id) throw new PlatformFault('conflict', 'This channel offers no release; publish one first');
    return this.releaseRow(tx, scope, current.release_id);
  }

  async planChannel(input: OrganizationActor, scope: EnvironmentScope, name: string, command: ChannelCommand, keyDigest: string, requestDigest: string): Promise<ChannelPlan> {
    return this.sql.begin(async tx => {
      const actor = await this.authorize(tx, input, scope, 'release.publish');
      const row = await this.target(tx, scope, name, command); const release = await this.toRelease(tx, row); const key = await this.keyOf(tx, scope, row.signing_profile_id);
      const existing = await this.replay(tx, actor.accountId, `channel:${scope.environmentId}:${name}`, keyDigest, requestDigest, result => parseComponent('ChannelReceipt', result));
      if (existing) return { existing, release, rollout: command.rollout, key };
      if (row.state !== 'published') throw new PlatformFault('conflict', 'A withdrawn release cannot be offered');
      return { release, rollout: command.rollout, key };
    });
  }

  async revise(input: ChannelRevisionWrite) {
    return this.sql.begin(async tx => {
      const { scope, name } = input; const actor = await this.authorize(tx, input.actor, scope, 'release.publish');
      await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
      const scopeKey = `channel:${scope.environmentId}:${name}`;
      const existing = await this.replay(tx, actor.accountId, scopeKey, input.keyDigest, input.requestDigest, result => parseComponent('ChannelReceipt', result));
      if (existing) return existing;
      // The manifest was signed for this release in an earlier transaction; it is only stored if the release is still what the channel should offer.
      const release = await this.target(tx, scope, name, input.command);
      if (release.id !== input.releaseId) throw new PlatformFault('conflict', 'The channel changed; refresh before retrying');
      if (release.state !== 'published') throw new PlatformFault('conflict', 'A withdrawn release cannot be offered');
      let channel = (await this.channelRow(tx, scope, name))[0];
      if ((channel?.revision ?? '0') !== input.expectedRevision) throw new PlatformFault('conflict', 'The channel changed; refresh before retrying');
      await tx`INSERT INTO update_feeds (environment_id, org_id, project_id, public_id) VALUES (${scope.environmentId}, ${scope.orgId}, ${scope.projectId}, ${input.feedId}) ON CONFLICT (environment_id) DO NOTHING`;
      const number = (channel?.current_revision ?? 0) + 1;
      if (!channel) {
        if ((await tx`SELECT 1 FROM channels WHERE environment_id = ${scope.environmentId}`).length >= MAX_CHANNELS) throw new PlatformFault('quota', 'This environment has reached its channel limit');
        channel = (await tx<Row[]>`INSERT INTO channels (environment_id, name, org_id, project_id, current_revision) VALUES (${scope.environmentId}, ${name}, ${scope.orgId}, ${scope.projectId}, 1) RETURNING *, revision::text`)[0]!;
      } else {
        channel = (await tx<Row[]>`UPDATE channels SET current_revision = ${number}, revision = revision + 1 WHERE environment_id = ${scope.environmentId} AND name = ${name} RETURNING *, revision::text`)[0]!;
      }
      await tx`INSERT INTO channel_revisions (environment_id, channel, number, release_id, rollout, reason, manifest, manifest_signature, manifest_digest, created_by, request_id)
        VALUES (${scope.environmentId}, ${name}, ${number}, ${release.id}, ${input.rollout}, ${input.command.kind}, ${input.manifest}, ${input.signature}, ${createHash('sha256').update(input.manifest).digest('hex')},
          ${actor.accountId}, ${input.requestId})`;
      const receipt = parseComponent('ChannelReceipt', { channel: await this.toChannel(tx, channel!), message: input.command.kind === 'publish' ? 'Channel now offers this release' : 'Rollout changed' });
      await this.remember(tx, actor.accountId, scopeKey, input.keyDigest, input.requestDigest, receipt);
      await this.event(tx, scope, 'channel', scope.environmentId, actor.accountId, input.command.kind === 'publish' ? 'channel.published' : 'channel.rollout_changed', channel!.revision, input.requestId);
      return receipt;
    });
  }

  async channels(input: OrganizationActor, scope: EnvironmentScope) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      const rows = await tx<Row[]>`SELECT *, revision::text FROM channels WHERE environment_id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} ORDER BY name`;
      const items: Channel[] = []; for (const row of rows) items.push(await this.toChannel(tx, row));
      return items;
    });
  }

  async channel(input: OrganizationActor, scope: EnvironmentScope, name: string) {
    return this.sql.begin(async tx => {
      await this.authorize(tx, input, scope, 'metadata.read');
      const row = (await this.channelRow(tx, scope, name))[0];
      if (!row) throw new PlatformFault('not_found', 'Channel not found');
      const revisions = await tx<Row[]>`SELECT r.*, l.version FROM channel_revisions r LEFT JOIN releases l ON l.id = r.release_id WHERE r.environment_id = ${scope.environmentId} AND r.channel = ${name} ORDER BY r.number DESC LIMIT 100`;
      return parseComponent('ChannelDetails', { channel: await this.toChannel(tx, row), revisions: revisions.map(revision) });
    });
  }

  // ── The public feed ──────────────────────────────────────────────────────

  async feed(feedId: string, channel: string): Promise<UpdateFeed | null> {
    // Only a live environment has a feed: an archived or suspended one stops answering.
    const row = (await this.sql<Row[]>`SELECT c.environment_id, r.manifest, r.manifest_signature FROM update_feeds f
      JOIN environments e ON e.id = f.environment_id JOIN projects p ON p.id = f.project_id JOIN organizations o ON o.id = f.org_id
      JOIN channels c ON c.environment_id = f.environment_id AND c.name = ${channel}
      JOIN channel_revisions r ON r.environment_id = c.environment_id AND r.channel = c.name AND r.number = c.current_revision
      WHERE f.public_id = ${feedId} AND e.state = 'active' AND p.state = 'active' AND o.state = 'active'`)[0];
    if (!row) return null;
    const withdrawn = await this.sql<Row[]>`SELECT version, withdrawn_reason, withdrawn_at FROM releases WHERE environment_id = ${row.environment_id} AND state = 'withdrawn' ORDER BY withdrawn_at, version`;
    return { manifest: row.manifest ? { text: row.manifest, signature: row.manifest_signature } : null,
      withdrawn: withdrawn.map(item => ({ version: item.version, reason: item.withdrawn_reason, withdrawnAt: item.withdrawn_at.toISOString() })) };
  }
}
