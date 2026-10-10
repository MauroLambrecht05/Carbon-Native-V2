import type { InternalAssertion } from '@carbon/contracts/platform';

/** Forward the original proof only to the configured Cloud origin; claims alone prove nothing. */
export class HttpAssertionAuthority {
  private readonly origin: string;
  constructor(origin: string, private readonly transport: typeof fetch = fetch) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Cloud authority requires a pinned HTTPS or explicit loopback origin');
    this.origin = url.origin;
  }
  async isCurrent(_assertion: InternalAssertion, token?: string): Promise<boolean> {
    if (!token || token.length > 32768) return false;
    const response = await this.transport(this.origin + '/internal/platform/v1/authority', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    if (response.status !== 200 || response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') { await response.body?.cancel(); return false; }
    const reader = response.body?.getReader(); if (!reader) return false;
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 256) return false; chunks.push(value); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return result && Object.keys(result).length === 1 && result.current === true;
    } catch { return false; } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
