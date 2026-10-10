import {
  PlatformFault, parseComponent, type CommandOptions, type EnvironmentCredentialCommand,
  type EnvironmentCredentialCreate, type EnvironmentCredentialIssue, type EnvironmentCredentialPage,
  type EnvironmentCredentialPermission, type EnvironmentCredentialReceipt, type EnvironmentScope, type PageRequest,
} from '@carbon/contracts/platform';
import { opaqueToken, tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { EnvironmentCredentialRepository } from '../ports/EnvironmentCredentialRepository.ts';

export class AccountEnvironmentCredentials {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: EnvironmentCredentialRepository, private readonly protector: MessageProtector) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage credentials');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }

  async list(token: string, scope: EnvironmentScope, query: PageRequest): Promise<EnvironmentCredentialPage> {
    parseComponent('EnvironmentScope', scope); parseComponent('PageRequest', query);
    if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const context = `environment-credentials:${actor.sessionId}:${actor.permissionRevision}:${scope.orgId}:${scope.projectId}:${scope.environmentId}:${limit}`;
    let afterId: string | undefined;
    if (query.cursor) {
      try { const value = JSON.parse(await this.protector.open(query.cursor, context)); afterId = parseComponent('Id', value.afterId); }
      catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    }
    const rows = await this.repository.list(actor, scope, limit + 1, afterId);
    const items = rows.slice(0, limit); const lookahead = rows[limit];
    const nextCursor = lookahead && items.length ? await this.protector.seal(JSON.stringify({ afterId: items.at(-1)!.id }), context) : null;
    return parseComponent('EnvironmentCredentialPage', { items, nextCursor });
  }

  async create(token: string, csrf: string, scope: EnvironmentScope, value: EnvironmentCredentialCreate,
    options: CommandOptions, requestId: string): Promise<EnvironmentCredentialIssue> {
    const input = parseComponent('EnvironmentCredentialCreate', { ...value, name: value.name.trim(), permissions: [...value.permissions].sort() });
    return this.issue(await this.actor(token, csrf), scope, { kind: 'create', ...input }, options, requestId);
  }

  async command(token: string, csrf: string, scope: EnvironmentScope, credentialId: string, value: EnvironmentCredentialCommand,
    options: CommandOptions, requestId: string): Promise<EnvironmentCredentialIssue | EnvironmentCredentialReceipt> {
    parseComponent('Id', credentialId); const command = parseComponent('EnvironmentCredentialCommand', value);
    const actor = await this.actor(token, csrf);
    if (command.kind === 'rotate') return this.issue(actor, scope, command, options, requestId, credentialId);
    return this.mutate(actor, scope, command, options, requestId, credentialId);
  }

  private async issue(actor: OrganizationActor, scope: EnvironmentScope,
    command: ({ readonly kind: 'create' } & EnvironmentCredentialCreate) | Extract<EnvironmentCredentialCommand, { kind: 'rotate' }>,
    options: CommandOptions, requestId: string, credentialId?: string): Promise<EnvironmentCredentialIssue> {
    const plaintext = opaqueToken('ce');
    const receipt = await this.mutate(actor, scope, command, options, requestId, credentialId,
      { prefix: plaintext.slice(0, 11), hash: tokenDigest(plaintext) });
    return parseComponent('EnvironmentCredentialIssue', { credential: receipt.credential, token: plaintext });
  }

  private async mutate(actor: OrganizationActor, scope: EnvironmentScope,
    command: ({ readonly kind: 'create' } & EnvironmentCredentialCreate) | EnvironmentCredentialCommand,
    options: CommandOptions, requestId: string, credentialId?: string, issued?: { prefix: string; hash: string }): Promise<EnvironmentCredentialReceipt> {
    parseComponent('EnvironmentScope', scope); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required');
    const canonical = command.kind === 'create' ? { ...command, permissions: [...command.permissions].sort() } : command;
    return this.repository.execute({ actor, scope, credentialId, command: canonical, token: issued,
      expectedRevision: options.expectedRevision, keyDigest: tokenDigest(options.idempotencyKey),
      requestDigest: tokenDigest(JSON.stringify({ scope, credentialId, command: canonical, expectedRevision: options.expectedRevision })), requestId });
  }
}

export class EnvironmentCredentialAuthentication {
  constructor(private readonly repository: EnvironmentCredentialRepository) {}
  verify(token: string, scope: EnvironmentScope, permission: EnvironmentCredentialPermission) {
    parseComponent('EnvironmentScope', scope); parseComponent('EnvironmentCredentialPermission', permission);
    if (!/^ce_[A-Za-z0-9_-]{43}$/.test(token)) throw new PlatformFault('unauthenticated', 'The environment credential is invalid');
    return this.repository.verify(token, scope, permission);
  }
}
