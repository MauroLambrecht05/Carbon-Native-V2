import { PlatformFault, parseComponent, canonicalDataImportRequest, dataImportPath, validateImportExecutionResult } from '@carbon/contracts/platform';
import { bodyDigest, sameScope, type ServiceAssertionIssuer } from '@carbon/identity';
import type { ImportLease, ImportTransport } from '../application/ports/ImportJobs.ts';

export class HttpImportClient implements ImportTransport {
  private readonly origin: string;
  constructor(origin: string, private readonly issuer: ServiceAssertionIssuer, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Import transport requires a pinned HTTPS or loopback origin');
    this.origin = url.origin;
  }
  async execute(work: ImportLease) { const result = await this.call(work, 'execute'); if (!result) throw new PlatformFault('unavailable', 'Missing import execution result'); return result; }
  status(work: ImportLease) { return this.call(work, 'status'); }
  private async call(work: ImportLease, action: 'execute' | 'status') {
    const request = parseComponent('DataImportServiceRequest', work.request); const bytes = canonicalDataImportRequest(request);
    if (Buffer.byteLength(bytes) > 393216) throw new PlatformFault('validation', 'Import request exceeds the byte limit');
    const path = dataImportPath(request.scope, request.bindingId, request.operationId, action);
    const proof = await this.issuer.issue({ aud: 'carbon-database', principal: work.principal, scope: request.scope, roles: [work.role], requestId: work.requestId,
      grants: [{ permission: action === 'execute' ? 'data.write' : 'metadata.read', scope: request.scope }], request: { method: 'POST', path, bodyDigest: bodyDigest(bytes) } });
    let response: Response;
    try { response = await this.transport(this.origin + path, { method: 'POST', body: bytes, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${proof}`, 'content-type': 'application/json', 'x-request-id': work.requestId, ...(action === 'execute' ? { 'idempotency-key': request.command.commandId } : {}) } }); }
    catch { throw new PlatformFault('unavailable', 'The import service could not be reached'); }
    if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || response.headers.get('x-request-id') !== work.requestId) {
      await response.body?.cancel(); throw new PlatformFault('unavailable', 'Invalid import service response');
    }
    const reader = response.body?.getReader(); if (!reader) throw new PlatformFault('unavailable', 'Empty import response');
    let decoded: unknown;
    try {
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 131072) throw new Error('Oversized'); chunks.push(value); }
      decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new PlatformFault('unavailable', 'Invalid import service response'); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (response.status !== 200) {
      const code = response.status === 400 ? 'validation' : response.status === 401 ? 'unauthenticated' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : response.status === 501 ? 'capability' : 'unavailable';
      let fields: Record<string, string> | undefined;
      try { const error = parseComponent('ErrorResponse', decoded).error; if (error.requestId === work.requestId && error.fieldErrors?.row && /^[1-9][0-9]{0,3}$/.test(error.fieldErrors.row)) fields = { row: error.fieldErrors.row }; } catch { /* Provider diagnostics are never forwarded. */ }
      throw new PlatformFault(code, 'The import service rejected this request', fields);
    }
    try {
      const result = parseComponent('DataImportServiceResponse', decoded);
      if (!sameScope(result.scope, request.scope) || result.bindingId !== request.bindingId || result.operationId !== request.operationId || result.leaseId !== request.leaseId) throw new Error('Foreign result');
      return result.result ? validateImportExecutionResult(result.result, request.command) : null;
    } catch { throw new PlatformFault('unavailable', 'Invalid import service response'); }
  }
}
