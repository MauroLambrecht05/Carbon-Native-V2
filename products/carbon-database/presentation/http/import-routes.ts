import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';
import { InvalidServiceAssertionError } from '@carbon/identity';
import type { ExecuteServiceImport } from '@carbon/data';

export function createImportRoutes(imports: ExecuteServiceImport) {
  return async (request: Request) => {
    let requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = crypto.randomUUID(); }
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url); const match = /^\/internal\/platform\/v1\/environments\/[^/]+\/imports\/[^/]+\/(execute|status)$/.exec(url.pathname);
      if (request.method !== 'POST' || !match) throw new PlatformFault('not_found', 'Import route not found');
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 32775) throw new PlatformFault('unauthenticated', 'A signed assertion is required');
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'JSON is required');
      const reader = request.body?.getReader(); if (!reader) throw new PlatformFault('validation', 'A body is required');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 393216) throw new PlatformFault('validation', 'Import request exceeds the byte limit'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks).toString('utf8'); let input: unknown;
      try { input = JSON.parse(bytes); } catch { throw new PlatformFault('validation', 'Invalid JSON'); }
      return Response.json(await imports.execute(authorization.slice(7), parseComponent('DataImportServiceRequest', input), match[1] as 'execute' | 'status', url.pathname + url.search,
        bytes, requestId, request.headers.get('idempotency-key'), request.signal), { headers });
    } catch (error) {
      const fault = error instanceof PlatformFault ? error : error instanceof InvalidServiceAssertionError ? new PlatformFault('unauthenticated', 'Invalid service assertion')
        : error instanceof ContractError ? new PlatformFault('validation', 'Invalid import request') : new PlatformFault('unavailable', 'The import service could not complete this request');
      const statuses = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, capability: 501 };
      return Response.json({ error: { code: fault.code, message: fault.message, requestId, ...(fault.fieldErrors ? { fieldErrors: fault.fieldErrors } : {}) } }, { status: statuses[fault.code as keyof typeof statuses] ?? 503, headers });
    }
  };
}
