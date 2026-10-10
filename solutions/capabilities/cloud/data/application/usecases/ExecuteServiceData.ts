import { PlatformFault, parseComponent, dataPermission, dataRequestPath, type DataRequest } from '@carbon/contracts/platform';
import { bodyDigest, type ServiceAssertionVerifier, type AssertionSecurityStore } from '@carbon/identity';
import type { NativeTablesRepository, NativeDataAuthority } from '../ports/NativeTables.ts';
import { generatedTypes } from '../../domain/GeneratedTypes.ts';
import { previewImport } from '../../domain/ImportPreview.ts';

export class ExecuteServiceData {
  constructor(private readonly verifier: ServiceAssertionVerifier, private readonly security: AssertionSecurityStore, private readonly repository: NativeTablesRepository) {}
  async execute(token: string, input: DataRequest, path: string, bytes: string, requestId: string, idempotencyKey: string | null, signal?: AbortSignal) {
    const request = parseComponent('DataRequest', input);
    const command = request.command; const permission = dataPermission(command.kind);
    if (path !== dataRequestPath(request.scope, request.bindingId, command.kind)) throw new PlatformFault('validation', 'Data request does not match its canonical path');
    if ('commandId' in command ? idempotencyKey !== command.commandId : idempotencyKey !== null) throw new PlatformFault('validation', 'Invalid data idempotency key');
    const assertion = await this.verifier.verify(token, { scope: request.scope, permission, method: 'POST', path, bodyDigest: bodyDigest(bytes), principalKinds: ['account','service_account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation does not match the signed assertion');
    // Application principals remain denied until the owning realm is verified by Cloud.
    const authority: NativeDataAuthority = { scope: request.scope, bindingId: request.bindingId, principal: assertion.principal, requestId,
      permit: async required => required === permission && !signal?.aborted && await this.security.isCurrent(assertion, token) };
    if (command.kind === 'table.types' || command.kind === 'rows.import-preview') {
      const table = await this.repository.get(authority, command.tableId);
      if (command.revision !== undefined && table.revision !== command.revision) throw new PlatformFault('conflict', 'Table revision changed');
      return parseComponent('DataResponse', { scope: request.scope, bindingId: request.bindingId,
        result: command.kind === 'table.types' ? generatedTypes(table) : previewImport(table, command.input) });
    }
    if (command.kind === 'table.preview') return parseComponent('DataResponse', { scope: request.scope, bindingId: request.bindingId,
      result: await this.repository.preview(authority, command.tableId, command.change) });
    if (command.kind === 'tables.list' || command.kind === 'table.get') {
      const result = command.kind === 'tables.list' ? await this.repository.list(authority, command) : await this.repository.get(authority, command.tableId);
      return parseComponent('DataResponse', { scope: request.scope, bindingId: request.bindingId, result });
    }
    if (command.kind === 'rows.query') {
      return parseComponent('DataResponse', { scope: request.scope, bindingId: request.bindingId, result: await this.repository.queryPage(authority, command) });
    }
    return parseComponent('DataResponse', { scope: request.scope, bindingId: request.bindingId, result: await this.repository.command(authority, command) });
  }
}
