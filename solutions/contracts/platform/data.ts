import { parseComponent } from './validation.ts';
import { PlatformFault } from './errors/PlatformFault.ts';
import type { DataRequest, Permission, EnvironmentScope, DataTablesQuery } from './types/Platform.ts';

/** Name pagination must carry its original ordering value, even if that table changes. */
export function dataTablePageOrder(input: DataTablesQuery) {
  const query = parseComponent('DataTablesQuery', input);
  const sort = query.sort ?? 'id'; const byName = sort === 'name' || sort === '-name';
  if ((query.afterName !== undefined) !== (byName && query.afterId !== undefined)) throw new PlatformFault('validation', 'Table continuation does not match the requested order');
  return { byName, descending: sort.startsWith('-') };
}

export function dataPermission(kind: DataRequest['command']['kind']): Permission {
  switch (kind) {
    case 'tables.list': case 'table.get': case 'table.preview': case 'table.types': case 'rows.import-preview': return 'metadata.read';
    case 'table.create': case 'table.policies': case 'table.alter': return 'resources.configure';
    case 'rows.query': case 'rows.changes': return 'data.read';
    case 'row.insert': case 'row.update': case 'row.delete': return 'data.write';
    default: throw new Error('Unsupported data operation');
  }
}
export function dataRequestPath(scope: EnvironmentScope, bindingId: string, kind: DataRequest['command']['kind']): string {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId); dataPermission(kind);
  return `/internal/platform/v1/environments/${scope.environmentId}/data/${kind}?orgId=${scope.orgId}&projectId=${scope.projectId}&bindingId=${bindingId}`;
}
/** Stable business digest bytes; never use raw object insertion order for receipts. */
export function canonicalDataRequest(input: DataRequest): string {
  const value = parseComponent('DataRequest', input);
  const normalize = (item: unknown, depth = 0): unknown => {
    if (depth > 24) throw new PlatformFault('validation', 'Data request exceeds the nesting limit');
    if (Array.isArray(item)) return item.map(child => normalize(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key], depth + 1)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}
