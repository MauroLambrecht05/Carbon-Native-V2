import { PlatformFault, parseComponent, serviceLifecycleBody, serviceLifecycleStatusPath, type ServiceOwner } from '@carbon/contracts/platform';
import { bodyDigest, sameScope, type ServiceAssertionIssuer } from '@carbon/identity';
import type { EnvironmentProvisioner, ProvisioningWork } from '../application/ports/EnvironmentProvisioner.ts';

/** Signed Cloud-to-owning-service transport. The service must implement the same lifecycle contract. */
export class HttpEnvironmentProvisioner implements EnvironmentProvisioner {
  private readonly origin: string;
  constructor(private readonly owner: ServiceOwner, endpoint: string, private readonly issuer: ServiceAssertionIssuer, private readonly transport: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Provisioning requires a pinned HTTPS service origin or explicit loopback development origin');
    this.origin = url.origin;
  }
  async apply(work: ProvisioningWork, signal: AbortSignal) {
    if (work.owner !== this.owner) throw new PlatformFault('capability', 'The owning service does not match this adapter');
    const command = parseComponent('ServiceLifecycleCommand', { scope: work.scope, bindingId: work.bindingId, operationId: work.operationId, stepId: work.stepId, leaseId: work.leaseId, action: work.action, remoteResourceId: work.remoteResourceId });
    const path = `/internal/platform/v1/environments/${work.scope.environmentId}/lifecycle`;
    const body = serviceLifecycleBody(command);
    const assertion = await this.issuer.issue({ aud: this.owner === 'database' ? 'carbon-database' : 'carbon-registry', principal: work.principal,
      scope: work.scope, roles: [work.role], grants: work.grants.filter(grant => grant.permission === 'resources.configure'), requestId: work.requestId,
      request: { method: 'POST', path, bodyDigest: bodyDigest(body) } });
    const response = await this.transport(this.origin + path, { method: 'POST', redirect: 'error', signal, body,
      headers: { authorization: `Bearer ${assertion}`, 'content-type': 'application/json', 'idempotency-key': work.stepId, 'x-request-id': work.requestId } });
    return this.readStatus(response, work);
  }
  async status(work: Pick<ProvisioningWork, 'owner' | 'scope' | 'bindingId' | 'principal' | 'role' | 'grants' | 'requestId'>, signal: AbortSignal) {
    if (work.owner !== this.owner) throw new PlatformFault('capability', 'The owning service does not match this adapter');
    const path = serviceLifecycleStatusPath(parseComponent('EnvironmentScope', work.scope), work.bindingId);
    const assertion = await this.issuer.issue({ aud: this.owner === 'database' ? 'carbon-database' : 'carbon-registry', principal: work.principal,
      scope: work.scope, roles: [work.role], grants: work.grants.filter(grant => grant.permission === 'metadata.read'), requestId: work.requestId,
      request: { method: 'GET', path, bodyDigest: bodyDigest('') } });
    const response = await this.transport(this.origin + path, { method: 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${assertion}`, 'x-request-id': work.requestId } });
    return this.readStatus(response, work);
  }
  private async readStatus(response: Response, work: Pick<ProvisioningWork, 'scope' | 'bindingId'>) {
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformFault(response.status === 501 ? 'capability' : response.status === 403 ? 'forbidden' : response.status === 409 ? 'conflict' : 'unavailable', 'The owning service rejected lifecycle work');
    }
    if (response.redirected || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
      await response.body?.cancel(); throw new PlatformFault('unavailable', 'The owning service returned an invalid response');
    }
    const reader = response.body?.getReader(); if (!reader) throw new PlatformFault('unavailable', 'The owning service returned an empty response');
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        length += value.byteLength; if (length > 32768) throw new Error('Response exceeds the limit'); chunks.push(value);
      }
      const result = parseComponent('ServiceLifecycleStatus', JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (result.bindingId !== work.bindingId || !sameScope(result.scope, work.scope)) throw new Error('Mismatched service scope');
      return { scope: result.scope, remoteResourceId: result.remoteResourceId, state: result.state };
    } catch { throw new PlatformFault('unavailable', 'The owning service returned an invalid lifecycle response'); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
