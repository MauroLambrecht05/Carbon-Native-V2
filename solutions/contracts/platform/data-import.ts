import { parseComponent } from './validation.ts';
import { PlatformFault } from './errors/PlatformFault.ts';
import type { DataImportServiceRequest, DataImportExecution, EnvironmentScope } from './types/Platform.ts';

export function dataImportPath(scope: EnvironmentScope, bindingId: string, operationId: string, action: 'execute' | 'status') {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId); parseComponent('Id', operationId);
  if (action !== 'execute' && action !== 'status') throw new Error('Invalid import action');
  return `/internal/platform/v1/environments/${scope.environmentId}/imports/${operationId}/${action}?orgId=${scope.orgId}&projectId=${scope.projectId}&bindingId=${bindingId}`;
}
export function canonicalDataImportRequest(input: DataImportServiceRequest): string {
  const request = parseComponent('DataImportServiceRequest', input);
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(normalize(request));
}
export function validateImportExecutionResult(input: unknown, command: DataImportExecution) {
  const result = parseComponent('DataImportExecutionResult', input);
  if (result.commandId.toLowerCase() !== command.commandId.toLowerCase() || result.tableId.toLowerCase() !== command.tableId.toLowerCase() || result.revision !== command.revision
    || result.total < 1 || result.total !== result.inserted + result.updated + result.skipped + result.failed
    || result.errors.length !== Math.min(result.failed, 100) || result.errorsTruncated !== (result.failed > 100)
    || (command.input.atomic && result.failed !== 0) || (command.input.conflict !== 'update' && result.updated !== 0) || (command.input.conflict !== 'skip' && result.skipped !== 0)) throw new PlatformFault('unavailable', 'Invalid import execution result');
  let previous = 0;
  for (const error of result.errors) { if (error.row <= previous || error.row > result.total) throw new PlatformFault('unavailable', 'Invalid import error evidence'); previous = error.row; }
  return result;
}
