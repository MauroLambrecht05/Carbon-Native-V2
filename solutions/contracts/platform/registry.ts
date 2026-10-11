import { parseComponent } from './validation.ts';
import { PlatformFault } from './errors/PlatformFault.ts';
import type { EnvironmentScope, Permission, RegistryCommand, RegistryRequest } from './types/Platform.ts';

export type RegistryKind = RegistryCommand['kind'];

// Reading what a namespace holds needs metadata.read. Claiming a publisher name configures the environment's
// resources. Submitting, yanking and withdrawing a version are acts of publishing.
const PERMISSIONS: Record<RegistryKind, Permission> = {
  'namespace.get': 'metadata.read', 'publishers.list': 'metadata.read', 'versions.list': 'metadata.read', 'version.get': 'metadata.read',
  'publisher.claim': 'resources.configure', 'version.submit': 'release.publish', 'version.yank': 'release.publish', 'version.withdraw': 'release.publish',
};

/** The one permission a Registry command needs. Unknown kinds are refused, never defaulted. */
export function registryPermission(kind: string): Permission {
  if (!Object.hasOwn(PERMISSIONS, kind)) throw new Error('Unsupported registry operation');
  return PERMISSIONS[kind as RegistryKind];
}
export function registryRequestPath(scope: EnvironmentScope, bindingId: string, kind: string): string {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId); registryPermission(kind);
  return `/internal/platform/v1/environments/${scope.environmentId}/registry/${kind}?orgId=${scope.orgId}&projectId=${scope.projectId}&bindingId=${bindingId}`;
}
/** Stable bytes for digests and signatures: keys sorted at every level, so the signed body does not depend on insertion order. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown, depth = 0): unknown => {
    if (depth > 12) throw new PlatformFault('validation', 'Value exceeds the nesting limit');
    if (Array.isArray(item)) return item.map(child => normalize(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}
export function canonicalRegistryRequest(input: RegistryRequest): string { return canonicalJson(parseComponent('RegistryRequest', input)); }
