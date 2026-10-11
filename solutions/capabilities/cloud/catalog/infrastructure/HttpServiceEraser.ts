import { PlatformFault, parseComponent, serviceErasureBody, serviceErasurePath, type ServiceErasureReceipt, type ServiceOwner } from '@carbon/contracts/platform';
import { bodyDigest, type ServiceAssertionIssuer } from '@carbon/identity';
import type { ErasureWork, ServiceEraser } from '../application/ports/EnvironmentErasure.ts';

/**
 * Signed Cloud-to-owning-service erasure. The assertion's principal is the platform itself, identified by the
 * erasure's own ID: no account's access is involved, and the owning service asks Cloud whether that erasure is on
 * record before acting.
 */
export class HttpServiceEraser implements ServiceEraser {
  private readonly origin: string;
  constructor(private readonly owner: ServiceOwner, endpoint: string, private readonly issuer: ServiceAssertionIssuer, private readonly transport: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Erasure requires a pinned HTTPS service origin or explicit loopback development origin');
    this.origin = url.origin;
  }

  async erase(work: ErasureWork, requestId: string, signal: AbortSignal): Promise<ServiceErasureReceipt> {
    if (work.owner !== this.owner) throw new PlatformFault('capability', 'The owning service does not match this adapter');
    const body = serviceErasureBody({ scope: work.scope, bindingId: work.bindingId, erasureId: work.erasureId, remoteResourceId: work.remoteResourceId });
    const path = serviceErasurePath(work.scope.environmentId);
    const assertion = await this.issuer.issue({ aud: this.owner === 'database' ? 'carbon-database' : 'carbon-registry',
      principal: { id: work.erasureId, kind: 'platform', audience: 'platform', credentialId: work.erasureId, permissionRevision: '1' },
      scope: work.scope, roles: [], grants: [{ permission: 'resources.configure', scope: work.scope }], requestId, request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    const response = await this.transport(this.origin + path, { method: 'POST', redirect: 'error', signal, body,
      headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json', 'idempotency-key': work.erasureId, 'x-request-id': requestId } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformFault(response.status === 501 ? 'capability' : response.status === 401 || response.status === 403 ? 'forbidden' : response.status === 409 ? 'conflict' : 'unavailable', 'The owning service did not erase the environment');
    }
    if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') { await response.body?.cancel(); throw new PlatformFault('unavailable', 'The owning service returned an invalid response'); }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 32768) throw new PlatformFault('unavailable', 'The owning service returned an invalid response');
    try { return parseComponent('ServiceErasureReceipt', JSON.parse(Buffer.from(bytes).toString('utf8'))); }
    catch { throw new PlatformFault('unavailable', 'The owning service returned an invalid erasure receipt'); }
  }
}
