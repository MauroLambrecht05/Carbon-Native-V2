import type { EnvironmentScope, ServiceErasureReceipt, ServiceOwner } from '@carbon/contracts/platform';

/** One owning service's resource for an environment whose deletion is final. */
export interface ErasureWork {
  readonly erasureId: string;
  readonly scope: EnvironmentScope;
  readonly owner: ServiceOwner;
  readonly bindingId: string;
  readonly remoteResourceId: string;
  /** How many deliveries have been started, this one included. */
  readonly attempt: number;
}

/** Delivers one erasure to its owning service and returns what the service said it removed. */
export interface ServiceEraser {
  erase(work: ErasureWork, requestId: string, signal: AbortSignal): Promise<ServiceErasureReceipt>;
}

export interface ErasureRepository {
  /** Takes erasures that are due. Each is held for a while, so two workers do not deliver the same one at once. */
  claim(limit: number): Promise<readonly ErasureWork[]>;
  /** Records that the owning service finished. False when the erasure was already completed. */
  complete(work: ErasureWork, receipt: ServiceErasureReceipt, requestId: string): Promise<boolean>;
  /** Records why a delivery did not finish. It is tried again later. */
  fail(work: ErasureWork, category: string): Promise<void>;
}
