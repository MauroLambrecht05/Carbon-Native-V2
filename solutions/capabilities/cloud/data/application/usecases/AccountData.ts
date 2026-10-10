import { PlatformFault, parseComponent, dataPermission, type AccountDataRequest, type EnvironmentScope, type CommandOptions, type DataRowBoundary } from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor } from '@carbon/identity';
import type { AccountDataAuthority, DataTransport } from '../ports/AccountDataAuthority.ts';

export class AccountData {
  constructor(private readonly auth: AccountAuthentication, private readonly authority: AccountDataAuthority, private readonly transport: DataTransport, private readonly protector: MessageProtector) {}
  async execute(token: string, csrf: string, scope: EnvironmentScope, input: AccountDataRequest, options: CommandOptions | undefined, requestId: string, signal?: AbortSignal) {
    const command = parseComponent('AccountDataRequest', input); parseComponent('EnvironmentScope', scope); parseComponent('Id', requestId);
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to access data');
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    if ('access' in command && command.access.mode !== 'policy-preview') throw new PlatformFault('forbidden', 'Account data requests require policy-preview access');
    const actor: OrganizationActor = { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
    const mutation = 'commandId' in command;
    if (mutation) {
      if (!options) throw new PlatformFault('validation', 'Command options are required'); parseComponent('CommandOptions', options);
      if (options.idempotencyKey !== command.commandId || !options.expectedRevision || ('revision' in command && options.expectedRevision !== command.revision)) throw new PlatformFault('validation', 'Command identity and revision must match the headers');
    }
    const resolved = await this.authority.authorize(actor, scope, dataPermission(command.kind), mutation, command.kind === 'table.create' ? options!.expectedRevision : undefined);
    const dispatch = { principal: resolved.principal, role: resolved.role, requestId };
    if (command.kind === 'rows.import-preview') {
      const response = await this.transport.execute({ scope, bindingId: resolved.bindingId, command }, dispatch, signal);
      return parseComponent('AccountDataImportPreview', { scope, preview: parseComponent('DataImportPreview', response.result) });
    }
    if (command.kind === 'table.types') {
      const response = await this.transport.execute({ scope, bindingId: resolved.bindingId, command }, dispatch, signal);
      return parseComponent('AccountDataGeneratedTypes', { scope, artifact: parseComponent('DataGeneratedTypes', response.result) });
    }
    if (command.kind === 'table.preview') {
      const response = await this.transport.execute({ scope, bindingId: resolved.bindingId, command }, dispatch, signal);
      return parseComponent('AccountDataSchemaPreview', { scope, preview: parseComponent('DataSchemaPreview', response.result) });
    }
    if ('commandId' in command) {
      const response = await this.transport.execute({ scope, bindingId: resolved.bindingId, command }, dispatch, signal);
      return { receipt: parseComponent('DataCommandReceipt', response.result) };
    }
    if (command.kind === 'table.get') {
      const response = await this.transport.execute({ scope, bindingId: resolved.bindingId, command }, dispatch, signal);
      return parseComponent('AccountDataTableDetails', { scope, table: parseComponent('DataTable', response.result) });
    }
    const limit = command.limit ?? (command.kind === 'tables.list' ? 50 : 100);
    const context = 'data-page:' + tokenDigest(JSON.stringify({ session: actor.sessionId, permission: actor.permissionRevision, scope, binding: resolved.bindingId,
      kind: command.kind, table: 'tableId' in command ? command.tableId : undefined, access: 'access' in command ? command.access : undefined,
      ...(command.kind === 'tables.list' ? { sort: command.sort ?? 'id', name: (command.name ?? '').toLowerCase() }
        : { filters: command.filters ?? [], columns: command.columns ?? null, selectedIds: command.selectedIds ?? null, sort: command.sort ?? null }), limit, revisions: resolved.access }));
    let afterId: string | undefined;
    let afterName: string | undefined;
    let afterSort: DataRowBoundary | undefined;
    if (command.cursor) {
      try {
        const cursor = JSON.parse(await this.protector.open(command.cursor, context));
        afterId = parseComponent('Id', cursor.afterId);
        if (command.kind === 'tables.list' && (command.sort === 'name' || command.sort === '-name')) afterName = parseComponent('DataIdentifier', cursor.afterName);
        if (command.kind === 'rows.query' && command.sort) afterSort = parseComponent('DataRowBoundary', cursor.afterSort);
        if (!Number.isSafeInteger(cursor.expiresAt) || cursor.expiresAt <= Date.now()) throw new Error('Expired');
      } catch { throw new PlatformFault('validation', 'Data cursor is invalid or expired; restart the list'); }
    }
    if (command.kind === 'tables.list') {
      const response = await this.transport.execute({ scope, bindingId: resolved.bindingId,
        command: { kind: 'tables.list', limit, sort: command.sort ?? 'id', name: command.name ?? '', ...(afterId ? { afterId } : {}), ...(afterName ? { afterName } : {}) } }, dispatch, signal);
      const page = parseComponent('DataTablesResult', response.result);
      const nextCursor = page.nextAfterId ? await this.protector.seal(JSON.stringify({ afterId: page.nextAfterId, ...(page.nextAfterName ? { afterName: page.nextAfterName } : {}), expiresAt: Date.now() + 900000 }), context) : null;
      return parseComponent('AccountDataTablesPage', { scope, tables: page.tables, nextCursor });
    }
    const response = await this.transport.execute({ scope, bindingId: resolved.bindingId,
      command: { kind: 'rows.query', tableId: command.tableId, access: command.access, limit, filters: command.filters, columns: command.columns, selectedIds: command.selectedIds, sort: command.sort, afterSort, ...(afterId ? { afterId } : {}) } }, dispatch, signal);
    const page = parseComponent('DataQueryResult', response.result);
    const nextCursor = page.nextAfterId ? await this.protector.seal(JSON.stringify({ afterId: page.nextAfterId, ...(page.nextSort ? { afterSort: page.nextSort } : {}), expiresAt: Date.now() + 900000 }), context) : null;
    return parseComponent('AccountDataPage', { scope, tableId: command.tableId, rows: page.rows, nextCursor });
  }
}
