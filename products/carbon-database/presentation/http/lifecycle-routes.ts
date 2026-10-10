import type { ApplyServiceLifecycle } from '@carbon/catalog';
import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';
import { InvalidServiceAssertionError } from '@carbon/identity';

export function createLifecycleRoutes(lifecycle: ApplyServiceLifecycle) {
  return async (request: Request): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = crypto.randomUUID(); }
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url); const route = /^\/internal\/platform\/v1\/environments\/([^/]+)\/lifecycle$/.exec(url.pathname);
      if (!route || !['POST', 'GET'].includes(request.method) || (request.method === 'POST' && url.search)) throw new PlatformFault('not_found', 'Route not found');
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 32775) throw new PlatformFault('unauthenticated', 'A signed service assertion is required');
      if (request.method === 'GET') {
        for (const key of url.searchParams.keys()) if (!['orgId', 'projectId', 'bindingId'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new PlatformFault('validation', 'Invalid lifecycle status query');
        const scope = parseComponent('EnvironmentScope', { orgId: url.searchParams.get('orgId'), projectId: url.searchParams.get('projectId'), environmentId: route[1] });
        const bindingId = parseComponent('Id', url.searchParams.get('bindingId'));
        return Response.json(await lifecycle.status(authorization.slice(7), scope, bindingId, url.pathname + url.search, requestId), { headers });
      }
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
      const reader = request.body?.getReader(); if (!reader) throw new PlatformFault('validation', 'A request body is required');
      const chunks: Uint8Array[] = []; let length = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength;
        if (length > 8192) throw new PlatformFault('validation', 'Request body exceeds the limit'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const body = Buffer.concat(chunks).toString('utf8'); let input: unknown;
      try { input = JSON.parse(body); } catch { throw new PlatformFault('validation', 'Invalid JSON'); }
      const command = parseComponent('ServiceLifecycleCommand', input);
      if (command.scope.environmentId !== route[1]) throw new PlatformFault('validation', 'The request does not match this environment');
      const result = await lifecycle.execute(authorization.slice(7), command, url.pathname, body, request.headers.get('idempotency-key') ?? '', requestId, request.signal);
      return Response.json(result, { headers });
    } catch (error) {
      const fault = error instanceof PlatformFault ? error : error instanceof InvalidServiceAssertionError ? new PlatformFault('unauthenticated', 'Invalid service assertion')
        : error instanceof ContractError ? new PlatformFault('validation', 'Invalid request') : new PlatformFault('unavailable', 'The owning service could not complete lifecycle work');
      const status = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, capability: 501 };
      return Response.json({ error: { code: fault.code, message: fault.message, requestId } }, { status: status[fault.code as keyof typeof status] ?? 503, headers });
    }
  };
}
