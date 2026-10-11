import type { BlobContent, BlobStorageRepository, ExecuteServiceBlobs } from '@carbon/data';
import { ContractError, PlatformFault, parseComponent } from '@carbon/contracts/platform';
import { InvalidServiceAssertionError } from '@carbon/identity';

const STATUS: Record<string, number> = { unauthenticated: 401, forbidden: 403, validation: 400, not_found: 404, conflict: 409, quota: 429, capability: 501 };
const KINDS = 'bucket\\.create|bucket\\.update|bucket\\.delete|buckets\\.list|bucket\\.get|objects\\.list|object\\.versions|object\\.upload|object\\.download|object\\.delete|object\\.restore';

/** Signed blob commands from Cloud: `/internal/platform/v1/environments/{id}/blobs/{kind}`. */
export function createBlobRoutes(blobs: ExecuteServiceBlobs) {
  return async (request: Request): Promise<Response> => {
    let requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    try { parseComponent('Id', requestId); } catch { requestId = crypto.randomUUID(); }
    const headers = { 'cache-control': 'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff' };
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || !new RegExp(`^/internal/platform/v1/environments/[^/]+/blobs/(${KINDS})$`).test(url.pathname)) throw new PlatformFault('not_found', 'Route not found');
      const authorization = request.headers.get('authorization') ?? '';
      if (!authorization.startsWith('Bearer ') || authorization.length > 32775) throw new PlatformFault('unauthenticated', 'A signed assertion is required');
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new PlatformFault('validation', 'A JSON request is required');
      const raw = new Uint8Array(await request.arrayBuffer());
      if (raw.byteLength > 65536) throw new PlatformFault('validation', 'Blob request exceeds the byte limit');
      const bytes = Buffer.from(raw).toString('utf8'); let input: unknown;
      try { input = JSON.parse(bytes); } catch { throw new PlatformFault('validation', 'Invalid JSON'); }
      return Response.json(await blobs.execute(authorization.slice(7), parseComponent('BlobRequest', input), url.pathname + url.search, bytes, requestId, request.headers.get('idempotency-key'), request.signal), { headers });
    } catch (error) {
      const errno = (error as { errno?: string })?.errno;
      const fault = error instanceof PlatformFault ? error : error instanceof InvalidServiceAssertionError ? new PlatformFault('unauthenticated', 'Invalid service assertion')
        : error instanceof ContractError ? new PlatformFault('validation', 'Invalid blob request')
        : errno === '23505' ? new PlatformFault('conflict', 'The request conflicts with an existing resource') : new PlatformFault('unavailable', 'The storage service could not complete this request');
      return Response.json({ error: { code: fault.code, message: fault.message, requestId, ...(fault.fieldErrors ? { fieldErrors: fault.fieldErrors } : {}) } }, { status: STATUS[fault.code] ?? 503, headers });
    }
  };
}

/**
 * The addresses bytes travel through. They take no session and no assertion:
 *
 *   PUT /storage/v1/transfers/{token}                 one upload, exactly as authorized
 *   GET /storage/v1/transfers/{token}                 one download
 *   GET /storage/v1/public/{environment}/{bucket}/{key}   a current object of a bucket that is public right now
 */
export function createBlobTransferRoutes(storage: BlobStorageRepository) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    const refuse = (status: number, code: string, message: string) => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    // An unknown, spent, expired or wrong-kind address is simply not there.
    const missing = () => refuse(404, 'not_found', 'Not found');
    // Bytes are served as an attachment with their stored type and nothing sniffed, so a stored file cannot run as a page of this origin.
    const serve = (content: BlobContent, cache: string) => new Response(Buffer.from(content.bytes) as never, { status: 200, headers: { ...headers, 'content-type': content.contentType, 'content-length': String(content.bytes.byteLength),
      'content-disposition': `attachment; filename="${content.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'cache-control': cache, etag: `"${content.sha256}"`, 'content-security-policy': "default-src 'none'; sandbox" } });
    try {
      const url = new URL(request.url); if (url.search) return missing();
      const transfer = /^\/storage\/v1\/transfers\/([^/]+)$/.exec(url.pathname);
      if (transfer) {
        if (request.method === 'PUT') { await storage.receive(transfer[1]!, request.body, { contentType: request.headers.get('content-type'), contentLength: request.headers.get('content-length') }); return new Response(null, { status: 204, headers: { ...headers, 'cache-control': 'no-store' } }); }
        if (request.method === 'GET') { const content = await storage.open(transfer[1]!); return content ? serve(content, 'no-store') : missing(); }
        return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, PUT' } });
      }
      const open = /^\/storage\/v1\/public\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (open) {
        if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } });
        let key: string; try { key = decodeURIComponent(open[3]!); } catch { return missing(); }
        const content = await storage.publicObject(open[1]!, open[2]!, key);
        // Short, so making a bucket private takes effect in shared caches within a minute.
        return content ? serve(content, 'public, max-age=60') : missing();
      }
      return missing();
    } catch (error) {
      if (error instanceof PlatformFault) return refuse(STATUS[error.code] ?? 503, error.code, error.message);
      return refuse(503, 'unavailable', 'The storage service could not complete this request');
    }
  };
}
