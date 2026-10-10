import { createHash, randomUUID } from 'node:crypto';
import type { WorkerLeaseInput } from '@carbon/catalog';
import {
  PlatformFault, parseComponent, type Build, type BuildArtifact, type BuildArtifactDeclare, type BuildCommand, type BuildCreate, type BuildDetails, type BuildLogAppend, type BuildLogPage,
  type BuildPage, type BuildProvenance, type BuildReceipt, type BuildSource, type CommandOptions, type EnvironmentScope, type PageRequest, type WorkerBuildComplete, type WorkerBuildInput,
} from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { ArtifactVerifier, PlatformBuildRepository } from '../ports/PlatformBuildRepository.ts';

/** The exact bytes a build's digest covers: keys in a fixed order, lists sorted, nothing optional left implicit. */
export function canonicalBuildSource(input: BuildSource): { source: BuildSource; digest: string } {
  const value = parseComponent('BuildSource', input);
  const source: BuildSource = { commitSha: value.commitSha, platform: value.platform, ...(value.repositoryId ? { repositoryId: value.repositoryId } : {}), repositoryUrl: value.repositoryUrl,
    secretNames: [...value.secretNames].sort(), targets: [...value.targets].sort() };
  return { source, digest: createHash('sha256').update(JSON.stringify(source)).digest('hex') };
}

/** Developers start, follow and cancel builds through the browser session. */
export class AccountBuilds {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: PlatformBuildRepository, private readonly cursors: MessageProtector) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage builds');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }

  /**
   * Queues a build of one exact commit. The input is canonicalized and digested here and never changes afterwards:
   * every attempt, on any worker, builds this same input.
   */
  async create(token: string, csrf: string, input: EnvironmentScope, value: BuildCreate, options: CommandOptions, requestId: string): Promise<BuildReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('BuildCreate', value); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    const { source, digest } = canonicalBuildSource(value);
    return this.repository.create({ actor: await this.actor(token, csrf), scope, id: randomUUID(), leaseId: randomUUID(), source, sourceDigest: digest,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ scope, digest })), requestId });
  }

  async list(token: string, input: EnvironmentScope, query: PageRequest): Promise<BuildPage> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('PageRequest', query);
    if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const context = `builds:${actor.sessionId}:${actor.permissionRevision}:${scope.environmentId}:${limit}`; let afterId: string | undefined;
    if (query.cursor) try { afterId = parseComponent('Id', JSON.parse(await this.cursors.open(query.cursor, context)).afterId); } catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    const rows = await this.repository.list(actor, scope, limit + 1, afterId); const items = rows.slice(0, limit);
    return parseComponent('BuildPage', { items, nextCursor: rows[limit] && items.length ? await this.cursors.seal(JSON.stringify({ afterId: items.at(-1)!.id }), context) : null });
  }

  async get(token: string, input: EnvironmentScope, buildId: string): Promise<BuildDetails> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', buildId);
    return this.repository.get(await this.actor(token), scope, buildId);
  }

  /** Log segments after a sequence number, in order. Poll with the returned nextSequence to follow a running build. */
  async logs(token: string, input: EnvironmentScope, buildId: string, after: number, limit: number): Promise<BuildLogPage> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', buildId);
    if (!Number.isInteger(after) || after < 0 || after > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new PlatformFault('validation', 'Invalid log range');
    const rows = await this.repository.logs(await this.actor(token), scope, buildId, after, limit + 1); const items = rows.slice(0, limit);
    return parseComponent('BuildLogPage', { items, nextSequence: rows.length > limit ? items.at(-1)!.sequence : null });
  }

  /** The provenance of a succeeded build: its input, the worker's reported materials and the artifacts Cloud verified. */
  async provenance(token: string, input: EnvironmentScope, buildId: string): Promise<BuildProvenance> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', buildId);
    return this.repository.provenance(await this.actor(token), scope, buildId);
  }

  async command(token: string, csrf: string, input: EnvironmentScope, buildId: string, value: BuildCommand, options: CommandOptions, requestId: string): Promise<BuildReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', buildId); parseComponent('BuildCommand', value); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required');
    return this.repository.cancel({ actor: await this.actor(token, csrf), scope, buildId, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ scope, buildId, kind: value.kind, expectedRevision: options.expectedRevision })), requestId });
  }
}

/** What the worker holding a build's lease can do: read the input, append logs, declare outputs, and finish. */
export class WorkerBuilds {
  constructor(private readonly repository: PlatformBuildRepository, private readonly artifacts: ArtifactVerifier) {}

  private lease(authorization: string, leaseId: string, leaseToken: string, requestId: string): WorkerLeaseInput {
    parseComponent('Id', leaseId); parseComponent('Id', requestId);
    const match = /^Bearer (wc_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) throw new PlatformFault('unauthenticated', 'A worker credential is required');
    if (!/^wl_[A-Za-z0-9_-]{43}$/.test(leaseToken)) throw new PlatformFault('unauthenticated', 'A lease token is required');
    return { tokenHash: tokenDigest(match[1]!), leaseId, leaseTokenHash: tokenDigest(leaseToken), requestId };
  }
  async input(authorization: string, leaseId: string, leaseToken: string, requestId: string): Promise<WorkerBuildInput> { return this.repository.input(this.lease(authorization, leaseId, leaseToken, requestId)); }
  async appendLog(authorization: string, leaseId: string, leaseToken: string, value: BuildLogAppend, requestId: string) {
    return this.repository.appendLog(this.lease(authorization, leaseId, leaseToken, requestId), parseComponent('BuildLogAppend', value));
  }
  async declareArtifact(authorization: string, leaseId: string, leaseToken: string, value: BuildArtifactDeclare, requestId: string): Promise<BuildArtifact> {
    const artifact = parseComponent('BuildArtifactDeclare', value);
    if (artifact.objectKey.includes('..')) throw new PlatformFault('validation', 'Invalid artifact object key');
    return this.repository.declareArtifact(this.lease(authorization, leaseId, leaseToken, requestId), artifact);
  }
  async complete(authorization: string, leaseId: string, leaseToken: string, value: WorkerBuildComplete, requestId: string): Promise<Build> {
    const result = parseComponent('WorkerBuildComplete', value); const lease = this.lease(authorization, leaseId, leaseToken, requestId);
    if (result.outcome === 'succeeded') {
      // A worker's word is not enough: every declared artifact must be in object storage, byte for byte, before the
      // build can succeed. Declarations cannot change afterwards, so what was verified is what is recorded.
      for (const artifact of await this.repository.declared(lease)) {
        const verified = await this.artifacts.verify(artifact).catch(() => { throw new PlatformFault('unavailable', 'Artifact storage could not be reached'); });
        if (!verified) throw new PlatformFault('conflict', 'A declared artifact is missing from storage or does not match its size and digest');
      }
    }
    return this.repository.complete(lease, result);
  }
}

/** Fails builds that can no longer make progress. Run on a timer after the lease sweeper; not reachable over HTTP. */
export class BuildOrchestration {
  constructor(private readonly repository: PlatformBuildRepository) {}
  async reconcile(requestId: string, limit = 50) { parseComponent('Id', requestId); return this.repository.reconcile(requestId, limit); }
}
