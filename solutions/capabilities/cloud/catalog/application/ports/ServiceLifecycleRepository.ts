import type { ServiceErasureCommand, ServiceErasureReceipt, ServiceLifecycleCommand, ServiceLifecycleStatus, Principal, EnvironmentScope } from '@carbon/contracts/platform';
export interface ServiceLifecycleRepository {
  status(scope: EnvironmentScope, bindingId: string, stillAuthorized: () => Promise<boolean>): Promise<ServiceLifecycleStatus>;
  execute(command: ServiceLifecycleCommand, principal: Principal, requestId: string, stillAuthorized: () => Promise<boolean>): Promise<ServiceLifecycleStatus>;
  /**
   * Destroys everything held for the environment and records the receipt, in one transaction. A second delivery
   * of the same erasure returns the same receipt and destroys nothing more.
   */
  erase(command: ServiceErasureCommand, requestId: string, stillAuthorized: () => Promise<boolean>): Promise<ServiceErasureReceipt>;
  /** Removes from the object store the bytes of erased environments that are still listed. Returns how many are left. */
  purgeErasedObjects(remove: (storageKey: string) => Promise<void>, limit?: number): Promise<number>;
}
