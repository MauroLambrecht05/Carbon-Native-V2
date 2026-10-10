import { PlatformFault, parseComponent, type AuditEntry, type AuditPage, type PageRequest, type PlatformEvent, type Scope, type SubscriptionMessage } from '@carbon/contracts/platform';
import type { MessageProtector } from '../ports/AccountNotification.ts';
import type { OrganizationActor } from '../ports/OrganizationRepository.ts';
import type { AuditLog, AuditPosition, OrganizationLifecycleStore } from '../ports/AuditLog.ts';
import { AccountAuthentication, tokenDigest } from './AccountAuthentication.ts';

export interface AuditStreamTiming { readonly pollMs: number; readonly heartbeatMs: number; readonly maxMs: number }
const DEFAULT_TIMING: AuditStreamTiming = { pollMs: 1000, heartbeatMs: 15_000, maxMs: 15 * 60_000 };

function event(item: AuditEntry): PlatformEvent {
  return parseComponent('PlatformEvent', { version: 1, id: item.id, sequence: item.sequence, scope: item.scope, resource: item.resource, action: item.action,
    occurredAt: item.occurredAt, requestId: item.requestId, ...(item.revision ? { revision: item.revision } : {}) });
}

/** Audit browsing and the live event feed for one organization, project or environment. */
export class AccountAudit {
  constructor(private readonly auth: AccountAuthentication, private readonly log: AuditLog, private readonly cursors: MessageProtector, private readonly timing: AuditStreamTiming = DEFAULT_TIMING) {}

  private async actor(token: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to read audit events');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  /** A cursor is sealed to the session, its permission revision and the exact scope, so it stops working when any of them changes. */
  private context(kind: 'audit' | 'events', actor: OrganizationActor, scope: Scope) {
    return `${kind}:${actor.sessionId}:${actor.permissionRevision}:${scope.orgId}:${scope.projectId ?? ''}:${scope.environmentId ?? ''}`;
  }
  private async open(cursor: string, context: string): Promise<AuditPosition> {
    try {
      const value = JSON.parse(await this.cursors.open(cursor, context));
      if (typeof value.transaction !== 'string' || typeof value.sequence !== 'string' || !/^\d{1,20}$/.test(value.transaction) || !/^\d{1,19}$/.test(value.sequence)) throw new Error();
      return { transaction: value.transaction, sequence: value.sequence };
    } catch { throw new PlatformFault('validation', 'The cursor is invalid or expired'); }
  }

  async list(token: string, input: Scope, query: PageRequest): Promise<AuditPage> {
    const scope = parseComponent('Scope', input); parseComponent('PageRequest', query);
    if (query.filter || query.sort) throw new PlatformFault('validation', 'Audit events are listed newest first');
    const actor = await this.actor(token); const limit = query.limit ?? 50; const context = this.context('audit', actor, scope);
    const slice = await this.log.browse(actor, scope, limit + 1, query.cursor ? await this.open(query.cursor, context) : undefined);
    const items = slice.entries.slice(0, limit); const position = slice.entries.length > limit ? slice.positions[limit - 1] : undefined;
    return parseComponent('AuditPage', { items, nextCursor: position ? await this.cursors.seal(JSON.stringify(position), context) : null });
  }

  /**
   * A server-sent event stream of SubscriptionMessage frames. Access is re-resolved on every poll; when it is gone the
   * stream sends one terminal authorization_revoked frame and ends. The stream closes itself after maxMs so a client
   * must reconnect, with its cursor, under its then-current authorization.
   */
  async stream(token: string, input: Scope, cursor: string | undefined, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const scope = parseComponent('Scope', input); const actor = await this.actor(token); const context = this.context('events', actor, scope);
    let position = cursor ? await this.open(cursor, context) : await this.log.head(actor, scope);
    // Fails here, before any frame, when the caller may not read this scope at all.
    await this.log.follow(actor, scope, 1, position);
    const encoder = new TextEncoder(); const timing = this.timing; const log = this.log; const cursors = this.cursors;
    const frame = async (state: SubscriptionMessage['state'], events: readonly PlatformEvent[] = []) => {
      const sealed = state === 'authorization_revoked' ? '' : await cursors.seal(JSON.stringify(position), context);
      const message = parseComponent('SubscriptionMessage', { state, cursor: sealed, events });
      return encoder.encode(`event: ${state}\n${sealed ? `id: ${sealed}\n` : ''}data: ${JSON.stringify(message)}\n\n`);
    };
    let stopped = false; signal?.addEventListener('abort', () => { stopped = true; }, { once: true });
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const started = Date.now(); let lastFrame = started;
        try {
          controller.enqueue(await frame('connected'));
          while (!stopped) {
            if (Date.now() - started >= timing.maxMs) { controller.enqueue(await frame('closed')); break; }
            let slice;
            try { slice = await log.follow(actor, scope, 100, position); }
            catch (error) {
              // Lost access is a normal end of stream; anything else is reported as closed without detail.
              const revoked = error instanceof PlatformFault && ['unauthenticated', 'forbidden', 'not_found', 'conflict'].includes(error.code);
              controller.enqueue(await frame(revoked ? 'authorization_revoked' : 'closed')); break;
            }
            if (slice.entries.length) { position = slice.positions.at(-1)!; controller.enqueue(await frame('connected', slice.entries.map(event))); lastFrame = Date.now(); if (slice.entries.length === 100) continue; }
            else if (Date.now() - lastFrame >= timing.heartbeatMs) { controller.enqueue(await frame('heartbeat')); lastFrame = Date.now(); }
            await new Promise(resolve => setTimeout(resolve, timing.pollMs));
          }
        } finally { controller.close(); }
      },
      cancel() { stopped = true; },
    });
  }
}

/** Organization state changes made by Cloud itself: operator suspension and the deletion timer. Not reachable over HTTP. */
export class OrganizationLifecycle {
  constructor(private readonly log: OrganizationLifecycleStore) {}
  async suspend(orgId: string, reasonCode: string, requestId: string) {
    parseComponent('Id', orgId); parseComponent('Id', requestId);
    if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(reasonCode)) throw new PlatformFault('validation', 'A reason code is required');
    return this.log.suspend(orgId, reasonCode, requestId);
  }
  async reinstate(orgId: string, requestId: string) { parseComponent('Id', orgId); parseComponent('Id', requestId); return this.log.reinstate(orgId, requestId); }
  async finalizeDeletions(requestId: string, limit = 50) { parseComponent('Id', requestId); return this.log.finalizeDeletions(requestId, limit); }
}
