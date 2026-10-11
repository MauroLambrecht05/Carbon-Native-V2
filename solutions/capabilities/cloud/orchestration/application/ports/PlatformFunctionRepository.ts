import type { WorkerLeaseInput } from '@carbon/catalog';
import type { FunctionExecutionLogs,
  EnvironmentScope, Function as PlatformFunction, FunctionCommand, FunctionDeploy, FunctionDetails, FunctionExecution, FunctionExecutionReceipt, FunctionReceipt, FunctionRevisionDetails, FunctionSchedule,
  FunctionScheduleReceipt, WorkerFunctionComplete, WorkerFunctionInput,
} from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

/** What every idempotent command carries. */
export interface CommandIdentity { readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string }

/** A fixed interval, or a cron expression already checked and read in an IANA time zone. */
export type ScheduleSpec = ({ readonly intervalSeconds: number } | { readonly cron: string; readonly timeZone: string }) & { readonly input: unknown };

export interface PlatformFunctionRepository {
  // Developers, through the browser session.
  deploy(actor: OrganizationActor, scope: EnvironmentScope, functionId: string, value: FunctionDeploy, codeDigest: string, command: CommandIdentity): Promise<FunctionReceipt>;
  list(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string): Promise<readonly PlatformFunction[]>;
  get(actor: OrganizationActor, scope: EnvironmentScope, functionId: string): Promise<FunctionDetails>;
  revision(actor: OrganizationActor, scope: EnvironmentScope, functionId: string, number: number): Promise<FunctionRevisionDetails>;
  command(actor: OrganizationActor, scope: EnvironmentScope, functionId: string, value: FunctionCommand, expectedRevision: string, command: CommandIdentity): Promise<FunctionReceipt>;
  invoke(actor: OrganizationActor, scope: EnvironmentScope, functionId: string, ids: { readonly executionId: string; readonly leaseId: string }, input: unknown, command: CommandIdentity): Promise<FunctionExecutionReceipt>;
  executions(actor: OrganizationActor, scope: EnvironmentScope, functionId: string, limit: number, afterId?: string): Promise<readonly FunctionExecution[]>;
  execution(actor: OrganizationActor, scope: EnvironmentScope, executionId: string): Promise<FunctionExecution>;
  executionLogs(actor: OrganizationActor, scope: EnvironmentScope, executionId: string): Promise<FunctionExecutionLogs>;
  executionCommand(actor: OrganizationActor, scope: EnvironmentScope, executionId: string, kind: 'cancel' | 'retry', ids: { readonly executionId: string; readonly leaseId: string }, expectedRevision: string,
    command: CommandIdentity): Promise<FunctionExecutionReceipt>;
  createSchedule(actor: OrganizationActor, scope: EnvironmentScope, functionId: string, scheduleId: string, spec: ScheduleSpec, command: CommandIdentity): Promise<FunctionScheduleReceipt>;
  schedules(actor: OrganizationActor, scope: EnvironmentScope, functionId: string): Promise<readonly FunctionSchedule[]>;
  scheduleCommand(actor: OrganizationActor, scope: EnvironmentScope, scheduleId: string, kind: 'pause' | 'resume' | 'delete', expectedRevision: string, command: CommandIdentity): Promise<FunctionScheduleReceipt>;
  // The worker that holds an execution's lease.
  input(lease: WorkerLeaseInput): Promise<WorkerFunctionInput>;
  complete(lease: WorkerLeaseInput, result: WorkerFunctionComplete): Promise<FunctionExecution>;
  // Cloud's own timers. No HTTP route reaches these.
  /** Ends executions that can no longer finish: past their deadline, or with no lease left to run on. */
  reconcile(requestId: string, limit: number): Promise<readonly FunctionExecution[]>;
  /** Removes the input, output and logs of executions that ended longer ago than the retention period. Returns how many. */
  prune(limit: number): Promise<number>;
  /** Creates the executions that are due. `now` exists so a test can move time; production passes nothing. */
  tick(requestId: string, limit: number): Promise<readonly FunctionExecution[]>;
}
