import { PlatformFault, parseComponent, type ServiceOwner } from '@carbon/contracts/platform';
import { sameScope } from '@carbon/identity';
import type { ErasureRepository, ErasureWork, ServiceEraser } from '../ports/EnvironmentErasure.ts';

const DELIVERY_TIMEOUT_MS = 120_000;

/**
 * Carries final deletions to the owning services. Each recorded erasure is delivered until the service confirms
 * it, and a confirmation counts only if it names exactly the resource that was asked for.
 *
 * A failed delivery is recorded and retried later; it never blocks the others.
 */
export class EraseEnvironments {
  constructor(private readonly repository: ErasureRepository, private readonly erasers: Partial<Record<ServiceOwner, ServiceEraser>>, private readonly options: { readonly timeoutMs?: number } = {}) {}

  /** Delivers what is due. Returns how many erasures were completed. */
  async execute(requestId: string, limit = 20): Promise<number> {
    parseComponent('Id', requestId); let completed = 0;
    for (const work of await this.repository.claim(limit)) {
      try {
        const eraser = this.erasers[work.owner];
        if (!eraser) throw new PlatformFault('capability', 'No transport is configured for this owning service');
        const receipt = parseComponent('ServiceErasureReceipt', await eraser.erase(work, requestId, AbortSignal.timeout(this.options.timeoutMs ?? DELIVERY_TIMEOUT_MS)));
        if (!matches(work, receipt)) throw new PlatformFault('conflict', 'The owning service confirmed a different resource');
        if (await this.repository.complete(work, receipt, requestId)) completed++;
      } catch (error) {
        await this.repository.fail(work, error instanceof PlatformFault ? `erasure.${error.code}` : 'erasure.unavailable');
      }
    }
    return completed;
  }
}

function matches(work: ErasureWork, receipt: { erasureId: string; bindingId: string; remoteResourceId: string; scope: ErasureWork['scope'] }): boolean {
  return receipt.erasureId === work.erasureId && receipt.bindingId === work.bindingId && receipt.remoteResourceId === work.remoteResourceId && sameScope(receipt.scope, work.scope);
}
