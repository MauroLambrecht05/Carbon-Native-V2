import type { ServiceLifecycleCommand, EnvironmentScope } from './types/Platform.ts';
import { parseComponent } from './validation.ts';

/** Stable bytes shared by the signer, Cloud authority and owning-service verifier. */
export function serviceLifecycleBody(input: ServiceLifecycleCommand): string {
  const value = parseComponent('ServiceLifecycleCommand', input);
  return JSON.stringify({ scope: { orgId: value.scope.orgId, projectId: value.scope.projectId, environmentId: value.scope.environmentId },
    bindingId: value.bindingId, operationId: value.operationId, stepId: value.stepId, leaseId: value.leaseId,
    action: value.action, remoteResourceId: value.remoteResourceId });
}

export function serviceLifecycleStatusPath(scope: EnvironmentScope, bindingId: string): string {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId);
  return `/internal/platform/v1/environments/${scope.environmentId}/lifecycle?orgId=${scope.orgId}&projectId=${scope.projectId}&bindingId=${bindingId}`;
}
