import { bodyDigest } from '@carbon/identity';
import { parseComponent, type DataImportExecution, type EnvironmentScope } from '@carbon/contracts/platform';

/** Native receipt intent is independent of job attempts and their lease IDs. */
export function importExecutionDigest(scope: EnvironmentScope, bindingId: string, input: DataImportExecution) {
  parseComponent('EnvironmentScope', scope); parseComponent('Id', bindingId);
  const command = parseComponent('DataImportExecution', input);
  return bodyDigest(JSON.stringify({ scope: { orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId }, bindingId,
    kind: command.kind, commandId: command.commandId, tableId: command.tableId, revision: command.revision,
    access: { mode: command.access.mode, ...('userId' in command.access ? { userId: command.access.userId } : {}) }, confirmation: command.confirmation,
    input: { format: command.input.format, text: command.input.text, conflict: command.input.conflict, atomic: command.input.atomic,
      mapping: Object.fromEntries(Object.entries(command.input.mapping).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) } }));
}
