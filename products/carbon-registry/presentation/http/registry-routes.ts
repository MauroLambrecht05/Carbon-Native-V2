import type { ExecuteServiceRegistry } from '@carbon/catalog';
import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';
import { InvalidServiceAssertionError } from '@carbon/identity';

export function createRegistryRoutes(registry: ExecuteServiceRegistry) {
  return async (request: Request): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = crypto.randomUUID(); }
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || !/^\/internal\/platform\/v1\/environments\/[^/]+\/registry\/(namespace\.get)$/.test(url.pathname)) throw new PlatformFault('not_found', 'Route not found');
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 32775) throw new PlatformFault('unauthenticated', 'A signed assertion is required');
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
      const reader = request.body?.getReader(); if (!reader) throw new PlatformFault('validation', 'A request body is required');
      const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
        if (length > 8192) throw new PlatformFault('validation', 'Request body exceeds the limit'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks).toString('utf8'); let input: unknown;
      try { input = JSON.parse(bytes); } catch { throw new PlatformFault('validation', 'Invalid JSON'); }
      return Response.json(await registry.execute(authorization.slice(7), parseComponent('RegistryRequest', input), url.pathname + url.search, bytes, requestId, request.signal), { headers });
    } catch (error) {
      const fault = error instanceof PlatformFault ? error : error instanceof InvalidServiceAssertionError ? new PlatformFault('unauthenticated', 'Invalid service assertion')
        : error instanceof ContractError ? new PlatformFault('validation', 'Invalid registry request') : new PlatformFault('unavailable', 'The registry service could not complete this request');
      const statuses = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, capability: 501 };
      return Response.json({ error: { code: fault.code, message: fault.message, requestId } }, { status: statuses[fault.code as keyof typeof statuses] ?? 503, headers });
    }
  };
}
