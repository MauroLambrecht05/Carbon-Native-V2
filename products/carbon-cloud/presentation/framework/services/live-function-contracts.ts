// Functions as Carbon Cloud really offers them. The mock's function contract
// describes drafts, handlers, memory sizes and promotion, none of which the
// service has; pages against the live service use this contract instead, and
// show only what exists.

import type { CommandOptions, Page, PageRequest, RequestContext, Result } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type LiveFunction = Readonly<{ id: string; name: string; state: "active" | "disabled"; activeRevision: number; latestRevision: number; revision: string; createdAt: string }>;
export type LiveFunctionRevision = Readonly<{ number: number; codeDigest: string; secretNames: readonly string[]; timeoutSeconds: number; createdAt: string }>;
export type LiveFunctionDetails = Readonly<{ function: LiveFunction; revisions: readonly LiveFunctionRevision[] }>;
export type LiveExecution = Readonly<{
  id: string; functionId: string; revisionNumber: number; state: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
  trigger: "manual" | "schedule" | "retry"; attempt: number; output: unknown; errorCategory: string | null; hasLogs: boolean; prunedAt: string | null;
  scheduleId: string | null; retryOf: string | null; revision: string; createdAt: string; startedAt: string | null; completedAt: string | null;
}>;
export type LiveExecutionLogs = Readonly<{ text: string; truncated: boolean; attempt: number; recordedAt: string }>;
export type LiveSchedule = Readonly<{
  id: string; functionId: string; intervalSeconds: number | null; cron: string | null; timeZone: string | null; input: unknown; state: "active" | "paused";
  nextRunAt: string; lastRunAt: string | null; lastSkippedAt: string | null; lastSkipReason: "overlap" | "function_disabled" | "limit" | "unavailable" | null; revision: string;
}>;
export type LiveDeploy = Readonly<{ name: string; code: string; secretNames: readonly string[]; timeoutSeconds: number }>;
export type LiveFunctionCommand = Readonly<{ kind: "enable" | "disable" } | { kind: "activate"; revision: number }>;
export type LiveScheduleCreate = Readonly<({ intervalSeconds: number } | { cron: string; timeZone: string }) & { input?: unknown }>;

export interface LiveFunctionService {
  list(context: RequestContext, page?: PageRequest): Promise<Result<Page<LiveFunction>>>;
  get(context: RequestContext, id: string): Promise<Result<LiveFunctionDetails>>;
  /** The code of one revision. Needs more than reading the function does. */
  code(context: RequestContext, id: string, revision: number): Promise<Result<string>>;
  deploy(context: RequestContext, input: LiveDeploy, options: CommandOptions): Promise<Result<CommandReceipt>>;
  command(context: RequestContext, id: string, command: LiveFunctionCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  /** Queues one execution. The receipt's `resourceId` is the execution to follow. */
  invoke(context: RequestContext, id: string, input: unknown, options: CommandOptions): Promise<Result<CommandReceipt>>;
  executions(context: RequestContext, id: string, page?: PageRequest): Promise<Result<Page<LiveExecution>>>;
  execution(context: RequestContext, executionId: string): Promise<Result<LiveExecution>>;
  /** What the execution printed, or null when it printed nothing or its contents were removed. */
  logs(context: RequestContext, executionId: string): Promise<Result<LiveExecutionLogs | null>>;
  executionCommand(context: RequestContext, executionId: string, kind: "cancel" | "retry", options: CommandOptions): Promise<Result<CommandReceipt>>;
  schedules(context: RequestContext, id: string): Promise<Result<readonly LiveSchedule[]>>;
  createSchedule(context: RequestContext, id: string, input: LiveScheduleCreate, options: CommandOptions): Promise<Result<CommandReceipt>>;
  scheduleCommand(context: RequestContext, scheduleId: string, kind: "pause" | "resume" | "delete", options: CommandOptions): Promise<Result<CommandReceipt>>;
}
