import type { CheckServiceAuthority } from '@carbon/catalog';

export function createAuthorityRoutes(authority: CheckServiceAuthority) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/internal/platform/v1/authority' || new URL(request.url).search) return new Response('{"current":false}', { status: 404, headers });
    const header = request.headers.get('authorization') ?? '';
    if (!header.startsWith('Bearer ') || header.length > 32775) return new Response('{"current":false}', { status: 200, headers });
    // No claims/body fields are accepted from the caller; only the original signed proof is inspected.
    await request.body?.cancel();
    try { return new Response(JSON.stringify({ current: await authority.execute(header.slice(7)) }), { headers }); }
    catch { return new Response('{"current":false}', { status: 503, headers }); }
  };
}
