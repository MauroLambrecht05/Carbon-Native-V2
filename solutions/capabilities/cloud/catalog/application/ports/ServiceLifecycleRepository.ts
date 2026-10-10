import type { ServiceLifecycleCommand, ServiceLifecycleStatus, Principal, EnvironmentScope } from '@carbon/contracts/platform';
export interface ServiceLifecycleRepository {
  status(scope: EnvironmentScope, bindingId: string, stillAuthorized: () => Promise<boolean>): Promise<ServiceLifecycleStatus>;
  execute(command: ServiceLifecycleCommand, principal: Principal, requestId: string, stillAuthorized: () => Promise<boolean>): Promise<ServiceLifecycleStatus>;
}
