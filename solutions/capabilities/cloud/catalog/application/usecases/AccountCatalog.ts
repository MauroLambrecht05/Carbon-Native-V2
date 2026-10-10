import { PlatformFault, parseComponent, type Scope, type CommandOptions, type PageRequest } from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { CatalogCommand, CatalogRepository } from '../ports/CatalogRepository.ts';

export class AccountCatalog {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: CatalogRepository, private readonly protector: MessageProtector) {}
  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to access the catalog');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  async get(token: string, scope: Scope) {
    parseComponent('Scope', scope); if (!scope.projectId || scope.realmId) throw new PlatformFault('validation', 'A catalog project scope is required');
    return this.repository.get(await this.actor(token), scope);
  }
  async list(token: string, scope: Scope, query: PageRequest) {
    parseComponent('Scope', scope); parseComponent('PageRequest', query);
    if (scope.environmentId || scope.realmId || query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering of projects or environments is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const context = `catalog:${actor.sessionId}:${actor.permissionRevision}:${scope.orgId}:${scope.projectId ?? ''}:${limit}`;
    let afterId: string | undefined; let revision: string | undefined;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(await this.protector.open(query.cursor, context));
        afterId = parseComponent('Id', cursor.afterId); revision = parseComponent('Revision', cursor.revision);
        if (!Number.isSafeInteger(cursor.expiresAt) || cursor.expiresAt <= Date.now()) throw new Error('Expired cursor');
      } catch { throw new PlatformFault('validation', 'The cursor is invalid or expired; restart the list'); }
    }
    const page = await this.repository.list(actor, scope, limit + 1, afterId, revision); const items = page.items.slice(0, limit);
    const nextCursor = page.items.length > limit ? await this.protector.seal(JSON.stringify({ afterId: items.at(-1)!.id, revision: page.revision, expiresAt: Date.now() + 900000 }), context) : null;
    return parseComponent(scope.projectId ? 'CatalogEnvironmentPage' : 'CatalogProjectPage', { items, nextCursor, revision: page.revision });
  }
  async operation(token: string, scope: Scope, operationId: string) {
    parseComponent('Scope', scope); parseComponent('Id', operationId);
    if (!scope.environmentId || scope.realmId) throw new PlatformFault('validation', 'An environment scope is required');
    return this.repository.operation(await this.actor(token), scope, operationId);
  }
  async execute(token: string, csrf: string, scope: Scope, command: CatalogCommand, options: CommandOptions, requestId: string) {
    parseComponent('Scope', scope); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (!options.expectedRevision || scope.realmId) throw new PlatformFault('validation', 'The current catalog revision is required');
    const component = { 'project-create': 'CatalogProjectCreate', 'project-command': 'CatalogProjectCommand', 'environment-create': 'CatalogEnvironmentCreate',
      'environment-command': 'CatalogEnvironmentCommand', 'operation-command': 'CatalogOperationCommand' } as const;
    parseComponent(component[command.action], command.input);
    if ((command.action === 'project-create' && scope.projectId)
      || (['project-command', 'environment-create'].includes(command.action) && (!scope.projectId || scope.environmentId))
      || (['environment-command', 'operation-command'].includes(command.action) && !scope.environmentId)) throw new PlatformFault('validation', 'The command does not match the catalog scope');
    if (command.action === 'operation-command') parseComponent('Id', command.operationId);
    if ('name' in command.input) {
      const name = command.input.name.trim();
      if (!name || /[\u0000-\u001f\u007f]/.test(name)) throw new PlatformFault('validation', 'Enter a name without control characters');
      command = { ...command, input: { ...command.input, name } } as CatalogCommand;
    }
    if ('services' in command.input) command = { ...command, input: { ...command.input, services: [...command.input.services].sort() } } as CatalogCommand;
    return this.repository.execute({ actor: await this.actor(token, csrf), scope, command, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ command, scope, revision: options.expectedRevision })), requestId });
  }
}

/** Makes due project and environment deletions final. Run on a timer; not reachable over HTTP. */
export class CatalogLifecycle {
  constructor(private readonly repository: CatalogRepository) {}
  async finalizeDeletions(requestId: string, limit = 50) { parseComponent('Id', requestId); return this.repository.finalizeDeletions(requestId, limit); }
}
