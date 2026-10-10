import type { Scope, ServiceOwner, Principal, Role, Grant, ServiceError } from '@carbon/contracts/platform';

export interface ProvisioningWork {
  readonly operationId: string;
  readonly stepId: string;
  readonly bindingId: string;
  readonly leaseId: string;
  readonly scope: Scope;
  readonly owner: ServiceOwner;
  readonly action: 'ensure' | 'pause' | 'resume';
  readonly principal: Principal;
  readonly role: Role;
  readonly grants: readonly Grant[];
  readonly remoteResourceId: string | null;
  readonly requestId: string;
}
export interface ProvisioningResult {
  readonly scope: Scope;
  readonly remoteResourceId: string;
  readonly state: 'active' | 'paused';
}
/** Owning services must atomically deduplicate by stepId and reject scope rebinding. */
export interface EnvironmentProvisioner {
  apply(work: ProvisioningWork, signal: AbortSignal): Promise<ProvisioningResult>;
}
export interface ProvisioningRepository {
  claim(): Promise<ProvisioningWork | 'settled' | null>;
  complete(work: ProvisioningWork, result: { value: ProvisioningResult } | { error: ServiceError }): Promise<boolean>;
}
