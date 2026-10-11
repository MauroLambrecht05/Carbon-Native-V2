import type { ExportDownloads } from '@carbon/data';

const BASE = '/platform/v1/exports/download/';

/**
 * Serves a single-use export download address. The token in the path is the whole credential: it works once, for a
 * minute, and the creator's access is checked again when it is used. No cookie is read and none is needed.
 */
export function createExportRoutes(downloads: ExportDownloads) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    // Every refusal looks the same: an unknown, spent, expired or revoked address is simply not there.
    const missing = () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'This download address is not valid' } }), { status: 404, headers: { ...headers, 'content-type': 'application/json' } });
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(BASE) || url.search) return missing();
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } });
      const opened = await downloads.open(url.pathname.slice(BASE.length));
      if (!opened) return missing();
      const { source } = opened;
      return new Response(opened.body, { status: 200, headers: { ...headers, 'content-type': source.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
        'content-length': String(source.bytes), 'content-disposition': `attachment; filename="export-${source.jobId}.${source.format}"` } });
    } catch {
      return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'The export could not be read' } }), { status: 503, headers: { ...headers, 'content-type': 'application/json' } });
    }
  };
}
