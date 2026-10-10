import { randomUUID } from 'node:crypto';
import type { AppAuthentication } from '@carbon/auth';
import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';

const BASE = '/app/v1/realms';
const STATUS: Record<string, number> = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, capability: 501, quota: 429, rate_limited: 429 };

/**
 * The public application authentication API, called by a customer's app on behalf of its own end users. It never
 * reads a Carbon account cookie: an end user is authenticated only by the app session token in the Authorization header.
 */
export function createAppRoutes(app: AppAuthentication, origin: string) {
  return async (request: Request, peerAddress: string): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = randomUUID(); }
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-request-id': requestId };
    const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
    try {
      const url = new URL(request.url);
      if (url.host !== new URL(origin).host) throw new PlatformFault('forbidden', 'Invalid request origin');
      const route = new RegExp(`^${BASE}/([^/]+)/(configuration|challenges|sessions|session|session/rotate|oidc/start|oidc/complete|assertions)$`).exec(url.pathname);
      if (!route || url.search) throw new PlatformFault('not_found', 'Route not found');
      const realmId = route[1]!; const action = route[2]!; const authorization = request.headers.get('authorization') ?? '';
      const body = async (): Promise<unknown> => {
        if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
        const raw = new Uint8Array(await request.arrayBuffer());
        if (raw.byteLength > 8192) throw new PlatformFault('validation', 'Request body exceeds the limit');
        try { return JSON.parse(Buffer.from(raw).toString('utf8')); } catch { throw new PlatformFault('validation', 'Invalid JSON request'); }
      };
      if (request.method === 'GET') {
        if (action === 'configuration') return json(await app.configuration(realmId));
        if (action === 'session') return json(await app.view(realmId, authorization));
        throw new PlatformFault('not_found', 'Route not found');
      }
      if (request.method === 'DELETE' && action === 'session') { await app.signOut(realmId, authorization, requestId); return json(undefined, 204); }
      if (request.method !== 'POST') throw new PlatformFault('not_found', 'Route not found');
      if (action === 'challenges') return json(await app.challenge(realmId, parseComponent('AppChallengeRequest', await body()), peerAddress, requestId), 202);
      if (action === 'sessions') return json(await app.signIn(realmId, parseComponent('AppSessionRequest', await body()), requestId), 201);
      if (action === 'session/rotate') return json(await app.rotate(realmId, authorization, requestId));
      if (action === 'oidc/start') return json(await app.oidcStart(realmId, parseComponent('AppOidcStart', await body()), peerAddress, requestId));
      if (action === 'oidc/complete') return json(await app.oidcComplete(realmId, parseComponent('AppOidcComplete', await body()), requestId), 201);
      if (action === 'assertions') return json(await app.exchange(realmId, authorization, parseComponent('AppAssertionExchange', await body()), requestId));
      throw new PlatformFault('not_found', 'Route not found');
    } catch (error) {
      // Never echo input, tokens or provider diagnostics.
      const fault = error instanceof PlatformFault ? error : error instanceof ContractError ? new PlatformFault('validation', 'Invalid request') : new PlatformFault('unavailable', 'The request could not be completed');
      return json({ error: { code: fault.code, message: fault.message, requestId } }, STATUS[fault.code] ?? 503);
    }
  };
}
