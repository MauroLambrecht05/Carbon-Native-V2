import { parseComponent } from './validation.ts';
import { PlatformFault } from './errors/PlatformFault.ts';
import type { EnvironmentScope, GraphCommand, GraphRequest, Permission, VectorCommand, VectorRequest } from './types/Platform.ts';

/** Command families that share one signed request shape: `/internal/platform/v1/environments/{id}/{family}/{kind}`. */
export type EngineFamily = 'vectors' | 'graph';
export type EngineKind = VectorCommand['kind'] | GraphCommand['kind'];

const PERMISSIONS: Record<EngineFamily, Record<string, Permission>> = {
  vectors: { 'collection.create': 'resources.configure', 'collection.delete': 'resources.configure', 'collections.list': 'metadata.read',
    'points.upsert': 'data.write', 'points.delete': 'data.write', 'points.get': 'data.read', 'points.query': 'data.read' },
  graph: { 'node.put': 'data.write', 'node.delete': 'data.write', 'edge.put': 'data.write', 'edge.delete': 'data.write', 'node.get': 'data.read', neighbors: 'data.read', traverse: 'data.read', path: 'data.read' },
};

/** The one permission a command needs. Unknown families and kinds are refused, never defaulted. */
export function enginePermission(family: string, kind: string): Permission {
  const permission = Object.hasOwn(PERMISSIONS, family) ? PERMISSIONS[family as EngineFamily][kind] : undefined;
  if (!permission || !Object.hasOwn(PERMISSIONS[family as EngineFamily], kind)) throw new Error('Unsupported engine operation');
  return permission;
}

export function engineRequestPath(family: EngineFamily, scope: EnvironmentScope, bindingId: string, kind: string): string {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId); enginePermission(family, kind);
  return `/internal/platform/v1/environments/${scope.environmentId}/${family}/${kind}?orgId=${scope.orgId}&projectId=${scope.projectId}&bindingId=${bindingId}`;
}

/** Stable bytes for digests and signatures: keys sorted at every level. */
export function canonicalEngineRequest(family: EngineFamily, input: VectorRequest | GraphRequest): string {
  const value = family === 'vectors' ? parseComponent('VectorRequest', input as VectorRequest) : parseComponent('GraphRequest', input as GraphRequest);
  const normalize = (item: unknown, depth = 0): unknown => {
    if (depth > 12) throw new PlatformFault('validation', 'Request exceeds the nesting limit');
    if (Array.isArray(item)) return item.map(child => normalize(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}
