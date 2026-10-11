import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';
import type { OperatorConsole } from '@carbon/identity';

const BASE = '/operator/v1';
const STATUS: Record<string, number> = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409 };

/**
 * Cloud's operator API. It takes an operator credential and nothing else: no cookie, no customer token.
 *
 *   GET  /operator/v1/orgs/{id}            the organization's state, deletion blockers and retained-record counts
 *   GET  /operator/v1/orgs/{id}/actions    what operators did to it
 *   POST /operator/v1/orgs/{id}            one command, with a reason
 */
export function createOperatorRoutes(console: OperatorConsole) {
  return async (request: Request): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = crypto.randomUUID(); }
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url); const route = new RegExp(`^${BASE}/orgs/([^/]+)(/actions)?$`).exec(url.pathname);
      if (!route || url.search) throw new PlatformFault('not_found', 'Route not found');
      // A browser never calls this. A request that carries a cookie or an Origin is not an operator tool.
      if (request.headers.has('cookie') || request.headers.has('origin')) throw new PlatformFault('forbidden', 'The operator API is not available to browsers');
      const authorization = request.headers.get('authorization') ?? '';
      if (request.method === 'GET') return Response.json(route[2] ? { items: await console.actions(authorization, route[1]!) } : await console.organization(authorization, route[1]!), { headers });
      if (request.method !== 'POST' || route[2]) throw new PlatformFault('not_found', 'Route not found');
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
      const raw = new Uint8Array(await request.arrayBuffer()); if (raw.byteLength > 8192) throw new PlatformFault('validation', 'Request body exceeds the limit');
      let input: unknown; try { input = JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new PlatformFault('validation', 'Invalid JSON'); }
      return Response.json(await console.execute(authorization, route[1]!, parseComponent('OperatorCommand', input as never), requestId), { headers });
    } catch (error) {
      const fault = error instanceof PlatformFault ? error : error instanceof ContractError ? new PlatformFault('validation', 'Invalid operator request') : new PlatformFault('unavailable', 'The operator API could not complete this request');
      return Response.json({ error: { code: fault.code, message: fault.message, requestId } }, { status: STATUS[fault.code] ?? 503, headers });
    }
  };
}
