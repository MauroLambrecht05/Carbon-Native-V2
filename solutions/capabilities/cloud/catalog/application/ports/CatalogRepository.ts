import type { OrganizationActor } from '@carbon/identity';
import type { CatalogProject, CatalogEnvironment, CatalogEnvironmentDetails, CatalogProjectCreate, CatalogEnvironmentCreate,
  CatalogProjectCommand, CatalogEnvironmentCommand, CatalogOperationCommand, CatalogReceipt, Scope, Operation } from '@carbon/contracts/platform';

export type CatalogCommand = { action: 'project-create'; input: CatalogProjectCreate }
  | { action: 'environment-create'; input: CatalogEnvironmentCreate }
  | { action: 'project-command'; input: CatalogProjectCommand }
  | { action: 'environment-command'; input: CatalogEnvironmentCommand }
  | { action: 'operation-command'; input: CatalogOperationCommand; operationId: string };
export interface CatalogMutation {
  readonly actor: OrganizationActor;
  readonly scope: Scope;
  readonly command: CatalogCommand;
  readonly expectedRevision: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly requestId: string;
}
export interface CatalogRepository {
  get(actor: OrganizationActor, scope: Scope): Promise<CatalogProject | CatalogEnvironmentDetails>;
  list(actor: OrganizationActor, scope: Scope, limit: number, afterId?: string, revision?: string): Promise<{ items: readonly (CatalogProject | CatalogEnvironment)[]; revision: string }>;
  operation(actor: OrganizationActor, scope: Scope, operationId: string): Promise<Operation>;
  execute(mutation: CatalogMutation): Promise<CatalogReceipt>;
  finalizeDeletions(requestId: string, limit: number): Promise<readonly Scope[]>;
}
