import type { ExecuteServiceData } from '@carbon/data';
import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';
import { InvalidServiceAssertionError } from '@carbon/identity';

export function createDataRoutes(data: ExecuteServiceData) {
  return async (request: Request): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = crypto.randomUUID(); }
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || !/^\/internal\/platform\/v1\/environments\/[^/]+\/data\/(rows\.import-preview|table\.types|table\.preview|table\.alter|tables\.list|table\.get|table\.create|table\.policies|rows\.query|rows\.changes|row\.insert|row\.update|row\.delete)$/.test(url.pathname)) throw new PlatformFault('not_found', 'Route not found');
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 32775) throw new PlatformFault('unauthenticated', 'A signed assertion is required');
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
      const reader = request.body?.getReader(); if (!reader) throw new PlatformFault('validation', 'A request body is required');
      const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
        if (length > 393216) throw new PlatformFault('validation', 'Data request exceeds the byte limit'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks).toString('utf8'); let input: unknown;
      try { input = JSON.parse(bytes); } catch { throw new PlatformFault('validation', 'Invalid JSON'); }
      return Response.json(await data.execute(authorization.slice(7), parseComponent('DataRequest', input), url.pathname + url.search, bytes, requestId,
        request.headers.get('idempotency-key'), request.signal), { headers });
    } catch (error) {
      const errno = (error as { errno?: string })?.errno;
      const fault = error instanceof PlatformFault ? error : error instanceof InvalidServiceAssertionError ? new PlatformFault('unauthenticated', 'Invalid service assertion')
        : error instanceof ContractError ? new PlatformFault('validation', 'Invalid data request')
        : errno === '42501' ? new PlatformFault('forbidden', 'Row policy does not permit this operation')
        : ['23505', '23503', '2BP01', '42P07', '42710'].includes(errno ?? '') ? new PlatformFault('conflict', 'The data conflicts with an existing resource or constraint')
        : ['23514', '23502', '22P02', '22003', '22001', '22007', '22008', '42804', '42846'].includes(errno ?? '') ? new PlatformFault('validation', 'Invalid column definition or data')
        : new PlatformFault('unavailable', 'The data service could not complete this request');
      const statuses = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, capability: 501 };
      return Response.json({ error: { code: fault.code, message: fault.message, requestId } }, { status: statuses[fault.code as keyof typeof statuses] ?? 503, headers });
    }
  };
}
