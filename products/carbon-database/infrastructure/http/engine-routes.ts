import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';
import { InvalidServiceAssertionError } from '@carbon/identity';

const STATUS: Record<string, number> = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, quota: 429, capability: 501 };

/** One family's signed commands from Cloud: `/internal/platform/v1/environments/{id}/{family}/{kind}`. */
export function createEngineRoutes(family: 'vectors' | 'graph', engine: { execute(token: string, input: unknown, path: string, bytes: string, requestId: string, idempotencyKey: string | null, signal?: AbortSignal): Promise<unknown> }) {
  const route = new RegExp(`^/internal/platform/v1/environments/[^/]+/${family}/[a-z]+(\\.[a-z]+)?$`);
  return async (request: Request): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = crypto.randomUUID(); }
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || !route.test(url.pathname)) throw new PlatformFault('not_found', 'Route not found');
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 32775) throw new PlatformFault('unauthenticated', 'A signed assertion is required');
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
      const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.byteLength > 4_194_304) throw new PlatformFault('validation', 'Request exceeds the byte limit');
      const bytes = Buffer.from(raw).toString('utf8'); let input: unknown;
      try { input = JSON.parse(bytes); } catch { throw new PlatformFault('validation', 'Invalid JSON'); }
      return Response.json(await engine.execute(authorization.slice(7), input, url.pathname + url.search, bytes, requestId, request.headers.get('idempotency-key'), request.signal), { headers });
    } catch (error) {
      const errno = (error as { errno?: string })?.errno;
      const fault = error instanceof PlatformFault ? error : error instanceof InvalidServiceAssertionError ? new PlatformFault('unauthenticated', 'Invalid service assertion')
        : error instanceof ContractError || (error instanceof Error && error.message === 'Unsupported engine operation') ? new PlatformFault('validation', 'Invalid request')
        : ['23505', '23503'].includes(errno ?? '') ? new PlatformFault('conflict', 'The request conflicts with existing data')
        // A walk or search that ran out of time is the request's size, not an outage.
        : errno === '57014' ? new PlatformFault('validation', 'The request is too large to answer within the time limit')
        : ['22P02', '22003', '22000', '2201E'].includes(errno ?? '') ? new PlatformFault('validation', 'Invalid value') : new PlatformFault('unavailable', 'The data service could not complete this request');
      return Response.json({ error: { code: fault.code, message: fault.message, requestId, ...(fault.fieldErrors ? { fieldErrors: fault.fieldErrors } : {}) } }, { status: STATUS[fault.code] ?? 503, headers });
    }
  };
}
