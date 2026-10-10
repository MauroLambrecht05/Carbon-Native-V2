import { PlatformFault, parseComponent, type ServiceOwner } from '@carbon/contracts/platform';
import { sameScope } from '@carbon/identity';
import type { EnvironmentProvisioner, ProvisioningRepository } from '../ports/EnvironmentProvisioner.ts';

export class ProvisionEnvironment {
  constructor(private readonly repository: ProvisioningRepository, private readonly providers: Readonly<Partial<Record<ServiceOwner, EnvironmentProvisioner>>>) {}
  async execute(): Promise<boolean> {
    const work = await this.repository.claim(); if (!work) return false; if (work === 'settled') return true;
    const abort = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = this.providers[work.owner];
      if (!provider) throw new PlatformFault('capability', 'The owning service is not configured');
      const value = await Promise.race([provider.apply(work, abort.signal), new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { abort.abort(); reject(new PlatformFault('unavailable', 'The owning service timed out')); }, 20000);
      })]);
      parseComponent('Scope', value.scope);
      if (!sameScope(value.scope, work.scope) || !value.remoteResourceId || value.remoteResourceId.length > 200
        || /[\u0000-\u001f\u007f]/.test(value.remoteResourceId) || value.state !== (work.action === 'pause' ? 'paused' : 'active')
        || (work.remoteResourceId !== null && value.remoteResourceId !== work.remoteResourceId)) throw new PlatformFault('unavailable', 'The owning service returned an invalid binding');
      await this.repository.complete(work, { value });
    } catch (error) {
      // Provider messages may contain URLs, credentials or customer data. Persist only controlled diagnostics.
      const code = error instanceof PlatformFault && ['capability', 'conflict', 'forbidden', 'unavailable'].includes(error.code) ? error.code : 'unavailable';
      await this.repository.complete(work, { error: parseComponent('ServiceError', { code,
        message: code === 'capability' ? 'The owning service is not configured' : 'The owning service could not complete this step; inspect configuration and retry', requestId: work.requestId }) });
    } finally { if (timeout) clearTimeout(timeout); abort.abort(); }
    return true;
  }
}
