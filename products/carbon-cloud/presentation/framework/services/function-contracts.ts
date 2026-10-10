import type { CommandOptions, Page, PageRequest, RequestContext, Result, Scope } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";
import type { Json } from "./data-contracts";

export type Handler = "echo" | "user-error" | "infrastructure-error" | "timeout" | "read-rows" | "read-blob";
export type FunctionConfig = {
  handler: Handler; authorization: "anonymous" | "app-session" | "service-credential";
  timeoutMs: number; memoryMb: number; concurrency: number;
  secrets: { name: string; secretId: string }[];
  resource?: { kind: "table"; tableId: string } | { kind: "blob"; bucketId: string; key: string };
};
export type FunctionDraft = { source: string; repositoryPath: string; config: FunctionConfig; revision: string; savedAt: string };
export type CloudFunction = { id: string; scope: Scope; name: string; status: "enabled" | "disabled" | "deleted"; draft: FunctionDraft; activeDeploymentId?: string; revision: string; createdAt: string };
export type FunctionSummary = Omit<CloudFunction, "draft">;
export type Deployment = {
  id: string; scope: Scope; functionId: string; source: string; sourceDigest: string; repositoryPath: string;
  config: FunctionConfig; secretVersions: { name: string; secretId: string; version: number }[];
  draftRevision: string; createdAt: string; actorId: string; promotedFrom?: string;
};
export type InvocationIdentity = { mode: "anonymous" } | { mode: "app-session" } | { mode: "service-credential"; credentialId: string };
export type InvocationInput = { payload: Json; headers: Record<string, string>; identity: InvocationIdentity; businessKey?: string };
export type Invocation = {
  id: string; scope: Scope; functionId: string; deploymentId: string; actorId: string; requestId: string;
  trigger: "http" | "schedule" | "retry"; scheduleId?: string; originalId?: string;
  state: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancel_requested" | "cancelled";
  revision: string; createdAt: string; startedAt?: string; finishedAt?: string; durationMs?: number;
  failureKind?: "user" | "infrastructure" | "authorization" | "timeout"; statusCode?: number;
  input?: InvocationInput; output?: Json; logs?: string[]; redacted: boolean;
};
export type FunctionSchedule = {
  id: string; scope: Scope; functionId: string; name: string; cron: string; timezone: string;
  enabled: boolean; missed: "skip" | "catch-up-once"; overlap: "skip" | "allow"; credentialId: string;
  nextRunAt: string; lastRunAt?: string; lastOutcome?: "queued" | "missed" | "overlap-skipped" | "authorization-failed";
  revision: string;
};
export type FunctionCommand =
  | { kind: "create"; name: string; source: string; repositoryPath: string; config: FunctionConfig }
  | { kind: "save"; id: string; source: string; repositoryPath: string; config: FunctionConfig }
  | { kind: "deploy"; id: string; simulateFailure: boolean }
  | { kind: "promote"; id: string; deploymentId: string; targetEnvironmentId: string; targetFunctionId?: string; targetRevision?: string; config: FunctionConfig; reviewed: boolean }
  | { kind: "rollback"; id: string; deploymentId: string }
  | { kind: "status"; id: string; status: "enabled" | "disabled" | "deleted"; confirmation: string }
  | { kind: "schedule.save"; id: string; scheduleId?: string; name: string; cron: string; timezone: string; enabled: boolean; missed: FunctionSchedule["missed"]; overlap: FunctionSchedule["overlap"]; credentialId: string }
  | { kind: "schedule.delete"; id: string; scheduleId: string };
export type InvocationQuery = PageRequest & { status?: Invocation["state"]; trigger?: Invocation["trigger"]; since?: string; until?: string };
export interface FunctionService {
  limits(context: RequestContext): Promise<Result<{ timeoutMs: number; memoryMb: readonly number[]; payloadBytes: number; concurrency: number; execution: string; scheduleSyntax: string }>>;
  list(context: RequestContext, page?: PageRequest): Promise<Result<Page<FunctionSummary>>>;
  get(context: RequestContext, id: string): Promise<Result<CloudFunction>>;
  deployments(context: RequestContext, id: string, page?: PageRequest): Promise<Result<Page<Deployment>>>;
  command(context: RequestContext, input: FunctionCommand, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  invoke(context: RequestContext, id: string, input: InvocationInput, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  invocations(context: RequestContext, id: string, query?: InvocationQuery): Promise<Result<Page<Invocation>>>;
  invocation(context: RequestContext, id: string, invocationId: string, content: boolean): Promise<Result<Invocation>>;
  retry(context: RequestContext, id: string, invocationId: string, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  cancel(context: RequestContext, id: string, invocationId: string, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  cancelDeployment(context: RequestContext, operationId: string, production: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  schedules(context: RequestContext, id: string, page?: PageRequest): Promise<Result<Page<FunctionSchedule>>>;
  previewSchedule(context: RequestContext, cron: string, timezone: string): Promise<Result<{ next: string[]; daylightSaving: string }>>;
}
