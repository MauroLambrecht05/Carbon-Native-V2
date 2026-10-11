import { parseComponent } from './validation.ts';
import { PlatformFault } from './errors/PlatformFault.ts';
import type { BlobCommand, BlobRequest, EnvironmentScope, Permission } from './types/Platform.ts';

/** The one permission each blob operation needs. Configuring buckets, seeing metadata, reading bytes and writing bytes are separate. */
export function blobPermission(kind: BlobCommand['kind']): Permission {
  switch (kind) {
    case 'bucket.create': case 'bucket.update': case 'bucket.delete': return 'resources.configure';
    case 'buckets.list': case 'bucket.get': case 'objects.list': case 'object.versions': return 'metadata.read';
    case 'object.download': return 'data.read';
    case 'object.upload': case 'object.delete': case 'object.restore': return 'data.write';
    default: throw new Error('Unsupported blob operation');
  }
}

export function blobRequestPath(scope: EnvironmentScope, bindingId: string, kind: BlobCommand['kind']): string {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId); blobPermission(kind);
  return `/internal/platform/v1/environments/${scope.environmentId}/blobs/${kind}?orgId=${scope.orgId}&projectId=${scope.projectId}&bindingId=${bindingId}`;
}

/** Stable bytes for digests and signatures: keys sorted at every level. */
export function canonicalBlobRequest(input: BlobRequest): string {
  const value = parseComponent('BlobRequest', input);
  const normalize = (item: unknown, depth = 0): unknown => {
    if (depth > 12) throw new PlatformFault('validation', 'Blob request exceeds the nesting limit');
    if (Array.isArray(item)) return item.map(child => normalize(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}
