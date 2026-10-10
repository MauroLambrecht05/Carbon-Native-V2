import type { OrganizationActor } from '@carbon/identity';
import type { DataImportJobCreate, DataImportJobCancel, DataImportJobReceipt, DataImportJobView, DataImportServiceRequest,
  DataImportExecutionResult, EnvironmentScope, Principal, Role, ServiceError } from '@carbon/contracts/platform';

export interface ImportLease {
  readonly request: DataImportServiceRequest;
  readonly principal: Principal;
  readonly role: Role;
  readonly requestId: string;
  readonly phase: 'execute' | 'reconcile';
  readonly cancelled: boolean;
  readonly retryable: boolean;
  readonly error: ServiceError | null;
}
export interface ImportTransport {
  execute(work: ImportLease): Promise<DataImportExecutionResult>;
  status(work: ImportLease): Promise<DataImportExecutionResult | null>;
}
export interface ImportJobs {
  enqueue(actor: OrganizationActor, scope: EnvironmentScope, input: DataImportJobCreate, requestId: string): Promise<DataImportJobReceipt>;
  get(actor: OrganizationActor, scope: EnvironmentScope, id: string): Promise<DataImportJobView>;
  cancel(actor: OrganizationActor, scope: EnvironmentScope, id: string, command: DataImportJobCancel): Promise<DataImportJobReceipt>;
  claim(): Promise<ImportLease | 'settled' | null>;
  allowExecution(work: ImportLease): Promise<ImportLease | null>;
  finish(work: ImportLease, result: DataImportExecutionResult | null): Promise<boolean>;
  reconcile(work: ImportLease, error: ServiceError, retryable: boolean): Promise<boolean>;
  review(work: ImportLease, error: ServiceError): Promise<boolean>;
}
