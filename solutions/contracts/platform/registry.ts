import { parseComponent } from './validation.ts';
import type { EnvironmentScope, Permission, RegistryRequest } from './types/Platform.ts';

export function registryPermission(kind: RegistryRequest['command']['kind']): Permission {
  switch (kind) {
    case 'namespace.get': return 'metadata.read';
    default: throw new Error('Unsupported registry operation');
  }
}
export function registryRequestPath(scope: EnvironmentScope, bindingId: string, kind: RegistryRequest['command']['kind']): string {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId); registryPermission(kind);
  return `/internal/platform/v1/environments/${scope.environmentId}/registry/${kind}?orgId=${scope.orgId}&projectId=${scope.projectId}&bindingId=${bindingId}`;
}
/** Stable digest bytes: the signed body must not depend on object insertion order. */
export function canonicalRegistryRequest(input: RegistryRequest): string {
  const value = parseComponent('RegistryRequest', input);
  return JSON.stringify({ bindingId: value.bindingId, command: { kind: value.command.kind },
    scope: { environmentId: value.scope.environmentId, orgId: value.scope.orgId, projectId: value.scope.projectId } });
}
