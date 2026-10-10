import type { PublicUpdateFeed } from '@carbon/orchestration';

const BASE = '/updates/v1';

/**
 * The public update feed installed apps poll: `{feed}/{channel}/manifest.json`, `manifest.sig` and `yanked.json`.
 * It is read-only and takes no credential. Nothing here trusts the caller, and nothing it returns is secret: the
 * manifest is signed, and an updater checks that signature against the key it pins.
 */
export function createUpdateRoutes(feed: PublicUpdateFeed) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    const missing = () => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), { status: 404, headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    try {
      const url = new URL(request.url);
      const route = new RegExp(`^${BASE}/([^/]+)/([^/]+)/(manifest\\.json|manifest\\.sig|yanked\\.json)$`).exec(url.pathname);
      if (!route || url.search) return missing();
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
      const document = await feed.read(route[1]!, route[2]!, route[3] as 'manifest.json' | 'manifest.sig' | 'yanked.json');
      if (!document) return missing();
      // A channel is a moving pointer, so shared caches may hold it only briefly: a withdrawal must reach installs within a minute.
      return new Response(request.method === 'HEAD' ? null : document.body, { status: 200, headers: { ...headers, 'content-type': document.contentType, 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' } });
    } catch {
      return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'The update feed could not be read' } }), { status: 503, headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
  };
}
