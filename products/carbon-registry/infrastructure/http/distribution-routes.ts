import type { RegistryPackages } from '@carbon/catalog';
import { ContractError, PlatformFault, parseComponent, type RegistryTrustBundle } from '@carbon/contracts/platform';

const STATUS: Record<string, number> = { validation: 400, not_found: 404, conflict: 409, capability: 501 };
const MAX_ARCHIVE_BYTES = 67108864;

/**
 * What Registry serves without a credential:
 *
 *   GET /registry/v1/trust                                             the signed trust bundle
 *   GET /registry/v1/packages/{publisher}/{name}                       published and revoked versions with their signed statements
 *   GET /registry/v1/packages/{publisher}/{name}/{version}/{target}    the archive of one published version
 *   PUT /registry/v1/uploads/{token}                                   one reserved upload; the token is the authority
 *
 * Nothing here is trusted because this endpoint returned it: an installer checks every answer against its pinned root key.
 */
export function createDistributionRoutes(packages: RegistryPackages, trust: RegistryTrustBundle) {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const headers: Record<string, string> = { 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url); if (url.search) throw new PlatformFault('validation', 'Query parameters are not supported');
      const upload = /^\/registry\/v1\/uploads\/([^/]+)$/.exec(url.pathname);
      if (upload) {
        if (request.method !== 'PUT') throw new PlatformFault('not_found', 'Route not found');
        // The declared length is checked before a byte is read, and the body is counted as it arrives.
        const declared = Number(request.headers.get('content-length') ?? Number.NaN);
        if (!Number.isInteger(declared) || declared < 1 || declared > MAX_ARCHIVE_BYTES) throw new PlatformFault('validation', 'A content length within the archive limit is required');
        const reader = request.body?.getReader(); if (!reader) throw new PlatformFault('validation', 'A request body is required');
        const chunks: Uint8Array[] = []; let length = 0;
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > declared) throw new PlatformFault('validation', 'The body is longer than declared'); chunks.push(value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const version = await packages.upload(upload[1]!, new Uint8Array(Buffer.concat(chunks)), requestId);
        return Response.json({ version }, { headers: { ...headers, 'cache-control': 'no-store' } });
      }
      if (request.method !== 'GET') throw new PlatformFault('not_found', 'Route not found');
      if (url.pathname === '/registry/v1/trust') return Response.json(parseComponent('RegistryTrustBundle', trust), { headers: { ...headers, 'cache-control': 'no-cache' } });
      const route = /^\/registry\/v1\/packages\/([^/]+)\/([^/]+)(?:\/([^/]+)\/([^/]+))?$/.exec(url.pathname);
      if (!route) throw new PlatformFault('not_found', 'Route not found');
      // Never cached as fresh: a revocation must be seen by the next request.
      if (!route[3]) return Response.json(await packages.publicPackage(route[1]!, route[2]!), { headers: { ...headers, 'cache-control': 'no-cache' } });
      const archive = await packages.publicArchive(route[1]!, route[2]!, decodeURIComponent(route[3]), route[4]!);
      return new Response(Buffer.from(archive.bytes) as never, { headers: { ...headers, 'content-type': 'application/zstd', 'content-length': String(archive.bytes.length), 'cache-control': 'no-cache',
        'x-carbon-sha256': archive.sha256, 'content-disposition': 'attachment' } });
    } catch (error) {
      const fault = error instanceof PlatformFault ? error : error instanceof ContractError || error instanceof URIError ? new PlatformFault('not_found', 'Not found') : new PlatformFault('unavailable', 'The registry could not complete this request');
      return Response.json({ error: { code: fault.code, message: fault.message, requestId } }, { status: STATUS[fault.code] ?? 503, headers: { ...headers, 'cache-control': 'no-store' } });
    }
  };
}
