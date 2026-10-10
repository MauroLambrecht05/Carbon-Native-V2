import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  PlatformFault, parseComponent, type CommandOptions, type EnvironmentScope, type PageRequest, type WorkerCapabilities, type WorkerCommand, type WorkerCredentialIssue,
  type WorkerEnrollmentCreate, type WorkerEnrollmentIssue, type WorkerEnrollRequest, type WorkerLease, type WorkerLeaseCommand, type WorkerLeaseOffer, type WorkerLeaseReceipt,
  type WorkerPage, type WorkerPurpose, type WorkerReceipt, type WorkerSecretBindings,
} from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { WorkerRepository } from '../ports/WorkerRepository.ts';

const ENROLLMENT_MS = 15 * 60_000;
const CREDENTIAL_MS = 30 * 86400_000;
function opaque(prefix: 'we' | 'wc' | 'wl') { return `${prefix}_${randomBytes(32).toString('base64url')}`; }
function bearer(authorization: string, prefix: 'wc'): string {
  const match = new RegExp(`^Bearer (${prefix}_[A-Za-z0-9_-]{43})$`).exec(authorization);
  if (!match) throw new PlatformFault('unauthenticated', 'A worker credential is required');
  return match[1]!;
}

/** Organization managers create one-time enrollments and disable, enable or revoke workers. */
export class AccountWorkers {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: WorkerRepository, private readonly cursors: MessageProtector, private readonly now: () => Date = () => new Date()) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage workers');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }

  async list(token: string, orgId: string, query: PageRequest): Promise<WorkerPage> {
    parseComponent('Id', orgId); parseComponent('PageRequest', query);
    if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const context = `workers:${actor.sessionId}:${actor.permissionRevision}:${orgId}:${limit}`; let afterId: string | undefined;
    if (query.cursor) try { afterId = parseComponent('Id', JSON.parse(await this.cursors.open(query.cursor, context)).afterId); } catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    const rows = await this.repository.list(actor, orgId, limit + 1, afterId); const items = rows.slice(0, limit);
    return parseComponent('WorkerPage', { items, nextCursor: rows[limit] && items.length ? await this.cursors.seal(JSON.stringify({ afterId: items.at(-1)!.id }), context) : null });
  }

  async createEnrollment(token: string, csrf: string, orgId: string, value: WorkerEnrollmentCreate, options: CommandOptions, requestId: string): Promise<WorkerEnrollmentIssue> {
    parseComponent('Id', orgId); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    const input = parseComponent('WorkerEnrollmentCreate', { ...value, name: value.name.trim(), purposes: [...value.purposes].sort() });
    const code = opaque('we');
    return this.repository.createEnrollment({ actor: await this.actor(token, csrf), orgId, id: randomUUID(), name: input.name, purposes: input.purposes, code, codeHash: tokenDigest(code),
      expiresAt: new Date(this.now().getTime() + ENROLLMENT_MS), keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ orgId, input })), requestId });
  }

  async command(token: string, csrf: string, orgId: string, workerId: string, value: WorkerCommand, options: CommandOptions, requestId: string): Promise<WorkerReceipt> {
    parseComponent('Id', orgId); parseComponent('Id', workerId); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    const command = parseComponent('WorkerCommand', value);
    if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required');
    return this.repository.execute({ actor: await this.actor(token, csrf), orgId, workerId, command, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ orgId, workerId, command, expectedRevision: options.expectedRevision })), requestId });
  }
}

/** What a worker can do with its own wc_ credential and, for one lease, its wl_ lease token. */
export class WorkerProtocol {
  constructor(private readonly repository: WorkerRepository, private readonly rateLimitKey: string, private readonly now: () => Date = () => new Date()) {}

  private credential() {
    const token = opaque('wc');
    return { token, tokenHash: tokenDigest(token), tokenPrefix: token.slice(0, 11), credentialExpiresAt: new Date(this.now().getTime() + CREDENTIAL_MS) };
  }
  private lease(authorization: string, leaseId: string, leaseToken: string, requestId: string) {
    parseComponent('Id', leaseId); parseComponent('Id', requestId);
    if (!/^wl_[A-Za-z0-9_-]{43}$/.test(leaseToken)) throw new PlatformFault('unauthenticated', 'A lease token is required');
    return { tokenHash: tokenDigest(bearer(authorization, 'wc')), leaseId, leaseTokenHash: tokenDigest(leaseToken), requestId };
  }

  async enroll(value: WorkerEnrollRequest, peer: string, requestId: string): Promise<WorkerCredentialIssue> {
    parseComponent('Id', requestId); const input = parseComponent('WorkerEnrollRequest', value);
    const peerDigest = createHmac('sha256', this.rateLimitKey).update(`worker-enroll:${peer}`).digest('hex');
    const capabilities: WorkerCapabilities = { ...input.capabilities, toolchains: [...input.capabilities.toolchains].sort() };
    return this.repository.enroll({ codeHash: tokenDigest(input.code), capabilities, peerDigest, ...this.credential(), requestId });
  }
  async rotate(authorization: string, requestId: string): Promise<WorkerCredentialIssue> {
    parseComponent('Id', requestId);
    return this.repository.rotate({ currentTokenHash: tokenDigest(bearer(authorization, 'wc')), ...this.credential(), requestId });
  }
  async claim(authorization: string, requestId: string): Promise<WorkerLeaseOffer> {
    parseComponent('Id', requestId); const leaseToken = opaque('wl');
    return this.repository.claim({ tokenHash: tokenDigest(bearer(authorization, 'wc')), leaseToken, leaseTokenHash: tokenDigest(leaseToken), requestId });
  }
  async command(authorization: string, leaseId: string, leaseToken: string, value: WorkerLeaseCommand, requestId: string): Promise<WorkerLeaseReceipt> {
    const command = parseComponent('WorkerLeaseCommand', value); const input = this.lease(authorization, leaseId, leaseToken, requestId);
    return command.kind === 'heartbeat' ? this.repository.heartbeat(input) : this.repository.complete(input);
  }
  async secrets(authorization: string, leaseId: string, leaseToken: string, requestId: string): Promise<WorkerSecretBindings> {
    return this.repository.materialize(this.lease(authorization, leaseId, leaseToken, requestId));
  }
}

export interface WorkerLeaseRequest {
  readonly scope: EnvironmentScope; readonly purpose: WorkerPurpose; readonly subjectId: string; readonly secretNames: readonly string[];
  readonly requiredPlatform?: WorkerCapabilities['platform']; readonly claimSeconds?: number; readonly deadlineSeconds?: number; readonly maxAttempts?: number;
}

/**
 * Lease authority for Cloud's own orchestration (build and function scheduling). It is deliberately not reachable
 * over HTTP: a browser session or an API credential can never grant itself a lease, and so can never read a secret.
 */
export class WorkerLeases {
  constructor(private readonly repository: WorkerRepository) {}

  async grant(request: WorkerLeaseRequest, requestId: string): Promise<WorkerLease> {
    const scope = parseComponent('EnvironmentScope', request.scope); parseComponent('WorkerPurpose', request.purpose); parseComponent('Id', request.subjectId); parseComponent('Id', requestId);
    const secretNames = [...new Set(request.secretNames)].sort();
    if (secretNames.length !== request.secretNames.length || secretNames.length > 50 || secretNames.some(name => !/^[A-Z][A-Z0-9_]{0,99}$/.test(name))) throw new PlatformFault('validation', 'Invalid leased secret names');
    const claimSeconds = request.claimSeconds ?? 300; const deadlineSeconds = request.deadlineSeconds ?? 3600; const maxAttempts = request.maxAttempts ?? 3;
    if (!Number.isInteger(claimSeconds) || claimSeconds < 1 || claimSeconds > 3600 || !Number.isInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 21600
      || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new PlatformFault('validation', 'Invalid lease bounds');
    return this.repository.grant({ id: randomUUID(), scope, purpose: request.purpose, subjectId: request.subjectId, secretNames, requiredPlatform: request.requiredPlatform,
      claimSeconds, deadlineSeconds, maxAttempts, requestId });
  }
  /** Cancels every open attempt for a subject. A cancelled lease cannot complete or deliver secrets. */
  async cancel(subjectId: string, requestId: string) { parseComponent('Id', subjectId); parseComponent('Id', requestId); return this.repository.cancel(subjectId, requestId); }
  /** Expires leases whose window passed and re-offers work a worker held and lost. Run on a timer. */
  async reclaim(requestId: string, limit = 100) { parseComponent('Id', requestId); return this.repository.reclaim(requestId, limit); }
}
