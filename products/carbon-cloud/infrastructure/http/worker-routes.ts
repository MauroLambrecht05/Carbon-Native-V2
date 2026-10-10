import { randomUUID } from 'node:crypto';
import type { WorkerProtocol } from '@carbon/catalog';
import type { WorkerBuilds } from '@carbon/orchestration';
import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';

const BASE = '/worker/v1';
const STATUS: Record<string, number> = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, capability: 501, quota: 429, rate_limited: 429 };

/**
 * The worker API. It authenticates with worker credentials only: no cookie, session, CSRF token or other credential
 * type is ever consulted, and a request that carries a browser Origin is refused outright.
 */
export function createWorkerRoutes(workers: WorkerProtocol, origin: string, builds?: WorkerBuilds) {
  return async (request: Request, peerAddress: string): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = randomUUID(); }
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-request-id': requestId };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    try {
      const url = new URL(request.url);
      if (url.host !== new URL(origin).host) throw new PlatformFault('forbidden', 'Invalid request origin');
      if (request.headers.has('origin') || request.headers.get('sec-fetch-site')) throw new PlatformFault('forbidden', 'The worker API is not available to browsers');
      if (request.method !== 'POST' || url.search) throw new PlatformFault('not_found', 'Route not found');
      const body = async (required: boolean, maximumBytes = 8192): Promise<unknown> => {
        const raw = new Uint8Array(await request.arrayBuffer());
        if (raw.byteLength > maximumBytes) throw new PlatformFault('validation', 'Request body exceeds the limit');
        if (!raw.byteLength && !required) return {};
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
        try { return JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new PlatformFault('validation', 'Invalid JSON request'); }
      };
      const authorization = request.headers.get('authorization') ?? '';
      if (url.pathname === `${BASE}/enroll`) return json(await workers.enroll(parseComponent('WorkerEnrollRequest', await body(true)), peerAddress, requestId), 201);
      if (url.pathname === `${BASE}/credential`) return json(await workers.rotate(authorization, requestId));
      if (url.pathname === `${BASE}/leases/claim`) return json(await workers.claim(authorization, requestId));
      const build = new RegExp(`^${BASE}/leases/([^/]+)/build(?:/(logs|artifacts|complete))?$`).exec(url.pathname);
      if (build) {
        if (!builds) throw new PlatformFault('capability', 'Builds are not configured');
        const leaseToken = request.headers.get('x-carbon-lease-token') ?? ''; const leaseId = build[1]!;
        if (!build[2]) return json(await builds.input(authorization, leaseId, leaseToken, requestId));
        // Log segments are the one large worker payload.
        if (build[2] === 'logs') return json(await builds.appendLog(authorization, leaseId, leaseToken, parseComponent('BuildLogAppend', await body(true, 270336)), requestId));
        if (build[2] === 'artifacts') return json(await builds.declareArtifact(authorization, leaseId, leaseToken, parseComponent('BuildArtifactDeclare', await body(true)), requestId), 201);
        return json(await builds.complete(authorization, leaseId, leaseToken, parseComponent('WorkerBuildComplete', await body(true)), requestId));
      }
      const lease = new RegExp(`^${BASE}/leases/([^/]+)(/secrets)?$`).exec(url.pathname);
      if (lease) {
        const leaseToken = request.headers.get('x-carbon-lease-token') ?? '';
        if (lease[2]) return json(await workers.secrets(authorization, lease[1]!, leaseToken, requestId));
        return json(await workers.command(authorization, lease[1]!, leaseToken, parseComponent('WorkerLeaseCommand', await body(true)), requestId));
      }
      throw new PlatformFault('not_found', 'Route not found');
    } catch (error) {
      // Never echo input, credentials or provider diagnostics.
      const fault = error instanceof PlatformFault ? error : error instanceof ContractError ? new PlatformFault('validation', 'Invalid worker request') : new PlatformFault('unavailable', 'The worker API could not complete this request');
      return json({ error: { code: fault.code, message: fault.message, requestId } }, STATUS[fault.code] ?? 503);
    }
  };
}
