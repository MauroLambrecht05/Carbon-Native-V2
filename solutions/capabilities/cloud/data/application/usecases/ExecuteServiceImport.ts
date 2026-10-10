import { PlatformFault, parseComponent, dataImportPath, type DataImportServiceRequest } from '@carbon/contracts/platform';
import { bodyDigest, type ServiceAssertionVerifier, type AssertionSecurityStore } from '@carbon/identity';
import type { NativeTablesRepository, NativeDataAuthority } from '../ports/NativeTables.ts';

export class ExecuteServiceImport {
  constructor(private readonly verifier: ServiceAssertionVerifier, private readonly security: AssertionSecurityStore, private readonly repository: NativeTablesRepository) {}
  async execute(token: string, input: DataImportServiceRequest, action: 'execute' | 'status', path: string, bytes: string, requestId: string, key: string | null, signal?: AbortSignal) {
    const request = parseComponent('DataImportServiceRequest', input); const permission = action === 'execute' ? 'data.write' : 'metadata.read';
    if (path !== dataImportPath(request.scope, request.bindingId, request.operationId, action) || (action === 'execute' ? key !== request.command.commandId : key !== null)) throw new PlatformFault('validation', 'Import request does not match its path or command identity');
    const assertion = await this.verifier.verify(token, { scope: request.scope, permission, method: 'POST', path, bodyDigest: bodyDigest(bytes), principalKinds: ['account'] });
    if (assertion.requestId !== requestId) throw new PlatformFault('validation', 'Request correlation does not match the assertion');
    const authority: NativeDataAuthority = { scope: request.scope, bindingId: request.bindingId, principal: assertion.principal, requestId,
      permit: async required => required === permission && !signal?.aborted && await this.security.isCurrent(assertion, token) };
    const result = action === 'execute' ? await this.repository.applyImport(authority, request.command) : await this.repository.importStatus(authority, request.command);
    return parseComponent('DataImportServiceResponse', { scope: request.scope, bindingId: request.bindingId, operationId: request.operationId, leaseId: request.leaseId, result });
  }
}
