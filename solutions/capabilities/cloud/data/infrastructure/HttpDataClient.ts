import { PlatformFault, parseComponent, canonicalDataRequest, dataRequestPath, dataPermission, dataTablePageOrder, type DataRequest, type DataResponse, type Principal, type Role } from '@carbon/contracts/platform';
import { bodyDigest, sameScope, type ServiceAssertionIssuer } from '@carbon/identity';

/** Cloud transport. Its caller resolves the current actor/role before dispatch;
 * the receiver independently asks Cloud to resolve live authority again. */
export class HttpDataClient {
  private readonly origin: string;
  constructor(origin: string, private readonly issuer: ServiceAssertionIssuer, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('Data transport requires a pinned HTTPS or loopback origin');
    this.origin = url.origin;
  }
  async execute(input: DataRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<DataResponse> {
    const request = parseComponent('DataRequest', input); const command = request.command;
    if (command.kind === 'tables.list') dataTablePageOrder(command);
    if (command.kind === 'rows.query' && (command.afterSort !== undefined) !== (command.sort !== undefined && command.afterId !== undefined)) throw new PlatformFault('validation', 'Incomplete row sort boundary');
    const body = canonicalDataRequest(request); if (Buffer.byteLength(body) > 393216) throw new PlatformFault('validation', 'Data request exceeds the byte limit');
    const path = dataRequestPath(request.scope, request.bindingId, command.kind);
    const proof = await this.issuer.issue({ aud: 'carbon-database', principal: actor.principal, scope: request.scope, roles: [actor.role],
      grants: [{ permission: dataPermission(command.kind), scope: request.scope }], requestId: actor.requestId,
      request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    const deadline = AbortSignal.timeout(20000);
    let response: Response;
    try { response = await this.transport(this.origin + path, { method: 'POST', body, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'x-request-id': actor.requestId,
        ...('commandId' in command ? { 'idempotency-key': command.commandId } : {}) } });
    } catch { throw new PlatformFault('unavailable', 'The data service could not be reached'); }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PlatformFault(response.status === 400 ? 'validation' : response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden'
        : response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : response.status === 501 ? 'capability' : 'unavailable', 'The data service rejected this request');
    }
    if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || response.headers.get('x-request-id') !== actor.requestId) {
      await response.body?.cancel(); throw new PlatformFault('unavailable', 'The data service returned an invalid response');
    }
    const reader = response.body?.getReader(); if (!reader) throw new PlatformFault('unavailable', 'The data service returned an empty response');
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 2179072) throw new Error('Oversized response'); chunks.push(value); }
      const result = parseComponent('DataResponse', JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (result.bindingId !== request.bindingId || !sameScope(result.scope, request.scope)) throw new Error('Mismatched data scope');
      if (command.kind === 'rows.query') {
        const page = parseComponent('DataQueryResult', result.result);
        if (page.tableId !== command.tableId || page.rows.length > (command.limit ?? 100) || (page.nextAfterId !== null && page.nextAfterId !== page.rows.at(-1)?.id)) throw new Error('Mismatched query result');
        if ((page.nextSort !== undefined) !== (command.sort !== undefined && page.nextAfterId !== null)) throw new Error('Mismatched sort boundary');
        if (page.nextSort && (page.rows.length !== (command.limit ?? 100) || (page.nextSort.sqlNull && page.nextSort.value !== null)
          || (command.afterSort && page.nextSort.revision !== command.afterSort.revision))) throw new Error('Invalid sort continuation');
        if (page.nextSort && command.sort && Object.hasOwn(page.rows.at(-1)!.values, command.sort.column)
          && JSON.stringify(page.nextSort.value) !== JSON.stringify(page.rows.at(-1)!.values[command.sort.column])) throw new Error('Mismatched projected sort value');
        let previous = command.afterId?.toLowerCase();
        const seen = new Set<string>();
        const ids = command.selectedIds ? new Set(command.selectedIds.map(id => id.toLowerCase())) : undefined;
        for (const row of page.rows) {
          const id = row.id.toLowerCase();
          if ((!command.sort && previous && id <= previous) || seen.has(id) || (ids && !ids.has(id))) throw new Error('Mismatched selected row');
          seen.add(id);
          if (command.columns !== undefined && (Object.keys(row.values).length !== command.columns.length || command.columns.some(name => !Object.hasOwn(row.values, name)))) throw new Error('Mismatched projection');
          previous = id;
        }
      }
      else if (command.kind === 'rows.changes') {
        const feed = parseComponent('DataChangesResult', result.result);
        if (feed.tableId !== command.tableId || feed.events.length > (command.limit ?? 100) || (feed.reset && feed.events.length)) throw new Error('Mismatched change feed');
      }
      else if (command.kind === 'tables.list') {
        const page = parseComponent('DataTablesResult', result.result);
        const order = dataTablePageOrder(command);
        const limit = command.limit ?? 50;
        if (page.tables.length > limit || (page.nextAfterId !== null && (page.tables.length !== limit || page.nextAfterId !== page.tables.at(-1)?.id))) throw new Error('Invalid table pagination');
        if ((page.nextAfterName !== undefined) !== (order.byName && page.nextAfterId !== null)
          || (page.nextAfterName !== undefined && page.nextAfterName !== page.tables.at(-1)?.name)) throw new Error('Invalid name continuation');
        let previous = command.afterId ? { id: command.afterId.toLowerCase(), name: command.afterName ?? '' } : undefined;
        const seen = new Set<string>();
        for (const table of page.tables) {
          const id = table.id.toLowerCase();
          if (seen.has(id) || !table.name.toLowerCase().includes((command.name ?? '').toLowerCase())) throw new Error('Invalid table filter');
          seen.add(id);
          if (previous) {
            const comparison = order.byName && table.name !== previous.name ? (table.name < previous.name ? -1 : 1) : id < previous.id ? -1 : id > previous.id ? 1 : 0;
            if (order.descending ? comparison >= 0 : comparison <= 0) throw new Error('Invalid table order');
          }
          previous = { id, name: table.name };
        }
      }
      else if (command.kind === 'rows.import-preview') {
        const preview = parseComponent('DataImportPreview', result.result);
        if (preview.tableId !== command.tableId || (command.revision !== undefined && preview.revision !== command.revision)
          || preview.total !== preview.valid + preview.invalid || preview.samples.length !== Math.min(preview.valid, 20)
          || preview.errors.length !== Math.min(preview.invalid, 100) || preview.errorsTruncated !== (preview.invalid > 100)) throw new Error('Mismatched import preview');
        const seen = new Set<number>();
        for (const group of [preview.samples, preview.errors]) {
          let previous = 0;
          for (const item of group) {
            if (item.row <= previous || item.row > preview.total || seen.has(item.row)) throw new Error('Invalid import row evidence');
            seen.add(item.row); previous = item.row;
          }
        }
      }
      else if (command.kind === 'table.types') {
        const artifact = parseComponent('DataGeneratedTypes', result.result);
        if (artifact.tableId !== command.tableId || (command.revision !== undefined && artifact.revision !== command.revision)
          || !artifact.filename.endsWith(`-${artifact.revision}.ts`)) throw new Error('Mismatched generated types');
      }
      else if (command.kind === 'table.preview') {
        if (parseComponent('DataSchemaPreview', result.result).tableId !== command.tableId) throw new Error('Mismatched schema preview');
      }
      else if (command.kind === 'table.get') {
        if (parseComponent('DataTable', result.result).id !== command.tableId) throw new Error('Mismatched table');
      }
      else {
        const receipt = parseComponent('DataCommandReceipt', result.result);
        if (receipt.commandId !== command.commandId || receipt.tableId !== command.tableId || (('rowId' in command) && receipt.rowId !== command.rowId)) throw new Error('Mismatched data receipt');
      }
      return result;
    } catch { throw new PlatformFault('unavailable', 'The data service returned an invalid response'); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
