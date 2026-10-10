import {
  PlatformFault, parseComponent, type CommandOptions, type EnvironmentSecretCommand, type EnvironmentSecretCreate,
  type EnvironmentSecretPage, type EnvironmentSecretReceipt, type EnvironmentScope, type PageRequest,
} from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { EnvironmentSecretRepository } from '../ports/EnvironmentSecretRepository.ts';

export class AccountEnvironmentSecrets {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: EnvironmentSecretRepository, private readonly cursorProtector: MessageProtector) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage secrets');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }

  async list(token: string, scope: EnvironmentScope, query: PageRequest): Promise<EnvironmentSecretPage> {
    parseComponent('EnvironmentScope', scope); parseComponent('PageRequest', query);
    if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const context = `environment-secrets:${actor.sessionId}:${actor.permissionRevision}:${scope.orgId}:${scope.projectId}:${scope.environmentId}:${limit}`;
    let afterId: string | undefined;
    if (query.cursor) {
      try { afterId = parseComponent('Id', JSON.parse(await this.cursorProtector.open(query.cursor, context)).afterId); }
      catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    }
    const rows = await this.repository.list(actor, scope, limit + 1, afterId); const items = rows.slice(0, limit);
    const nextCursor = rows[limit] && items.length ? await this.cursorProtector.seal(JSON.stringify({ afterId: items.at(-1)!.id }), context) : null;
    return parseComponent('EnvironmentSecretPage', { items, nextCursor });
  }

  async create(token: string, csrf: string, scope: EnvironmentScope, value: EnvironmentSecretCreate,
    options: CommandOptions, requestId: string): Promise<EnvironmentSecretReceipt> {
    const input = parseComponent('EnvironmentSecretCreate', value);
    if (Buffer.byteLength(input.value, 'utf8') > 65536) throw new PlatformFault('validation', 'Secret value exceeds 64 KiB');
    return this.mutate(await this.actor(token, csrf), scope, { kind: 'create', ...input }, options, requestId);
  }

  async command(token: string, csrf: string, scope: EnvironmentScope, secretId: string, value: EnvironmentSecretCommand,
    options: CommandOptions, requestId: string): Promise<EnvironmentSecretReceipt> {
    parseComponent('Id', secretId); const command = parseComponent('EnvironmentSecretCommand', value);
    if (command.kind === 'rotate' && Buffer.byteLength(command.value, 'utf8') > 65536) throw new PlatformFault('validation', 'Secret value exceeds 64 KiB');
    return this.mutate(await this.actor(token, csrf), scope, command, options, requestId, secretId);
  }

  private async mutate(actor: OrganizationActor, scope: EnvironmentScope,
    command: ({ readonly kind: 'create' } & EnvironmentSecretCreate) | EnvironmentSecretCommand,
    options: CommandOptions, requestId: string, secretId?: string) {
    parseComponent('EnvironmentScope', scope); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required');
    const digestCommand = command.kind === 'create' || command.kind === 'rotate'
      ? { ...command, value: undefined, valueDigest: tokenDigest(command.value) } : command;
    return this.repository.execute({ actor, scope, secretId, command, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ scope, secretId, command: digestCommand, expectedRevision: options.expectedRevision })), requestId });
  }
}
