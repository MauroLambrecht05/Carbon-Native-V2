import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2', '.map': 'application/json' };
// The page may load only what this origin serves, and may talk only to this origin.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': CSP };

/**
 * Serves the built console (`bun run build:live`) from the same origin as the API, which is what its session
 * cookies require. A path with a file extension is a file or a 404. Any other path is the application, which
 * routes it in the browser. It never serves anything outside the build directory.
 */
export function createFrontendRoutes(directory: string) {
  const root = resolve(directory); const index = join(root, 'index.html');
  if (!existsSync(index)) throw new Error(`No built console at ${root}. Run: bun run build:live`);
  return (request: Request): Response => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', ...SECURITY } });
    let path: string; try { path = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Not found', { status: 404, headers: SECURITY }); }
    const send = (file: string, cache: string, status = 200) => new Response(request.method === 'HEAD' ? null : readFileSync(file), { status, headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': cache, ...SECURITY } });
    if (extname(path)) {
      const file = resolve(root, `.${path}`);
      if (!file.startsWith(root + sep) || path.includes('\0') || !existsSync(file) || !statSync(file).isFile()) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store', ...SECURITY } });
      // Built assets carry a content hash in their name, so they never change under a URL.
      return send(file, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    // The application shell is never cached: a new release must be picked up on the next visit.
    return send(index, 'no-store');
  };
}
