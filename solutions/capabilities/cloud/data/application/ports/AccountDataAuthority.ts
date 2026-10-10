import type { AccessSnapshot, DataRequest, DataResponse, EnvironmentScope, Permission, Principal, Role } from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

export interface AccountDataAuthority {
  authorize(actor: OrganizationActor, scope: EnvironmentScope, permission: Permission, mutation: boolean, environmentRevision?: string): Promise<{ principal: Principal; role: Role; bindingId: string; access: AccessSnapshot }>;
}
export interface DataTransport {
  execute(request: DataRequest, actor: { principal: Principal; role: Role; requestId: string }, signal?: AbortSignal): Promise<DataResponse>;
}
