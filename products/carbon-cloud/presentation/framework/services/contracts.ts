// Browser contract v1. Opaque identifiers/revisions must never be parsed by pages.
// Decimal and bigint values cross this boundary as base-10 strings, dates as UTC ISO.
export type Scope = Readonly<{
  orgId: string;
  projectId?: string;
  environmentId?: string;
}>;
export type RequestContext = Readonly<{ scope: Scope; signal?: AbortSignal }>;
export type AccountContext = Readonly<{ signal?: AbortSignal }>;
export type CommandOptions = Readonly<{
  idempotencyKey: string;
  expectedRevision?: string;
}>;
export type PageRequest = Readonly<{
  cursor?: string;
  limit?: number;
  filter?: { name?: string };
  sort?: "name" | "id";
}>;
export type AuditRequest = PageRequest & Readonly<{
  actorId?: string;
  action?: string;
  outcome?: "succeeded" | "failed";
  projectId?: string;
  environmentId?: string;
}>;
export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
  total: number;
}>;
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation"
  | "conflict"
  | "rate_limited"
  | "quota_exceeded"
  | "unavailable"
  | "unsupported_operation"
  | "cancelled";
export type ServiceError = Readonly<{
  code: ErrorCode;
  message: string;
  requestId: string;
  fieldErrors?: Readonly<Record<string, string>>;
  retryAfterMs?: number;
}>;
export type Result<T> = Readonly<
  { ok: true; value: T } | { ok: false; error: ServiceError }
>;
import type { Permission, Role } from "../../../../../solutions/contracts/platform/types/Platform.ts";
export type { Permission, Role } from "../../../../../solutions/contracts/platform/types/Platform.ts";
export type Action = Readonly<{ allowed: boolean; reason?: string }>;
export type Permissions = Readonly<Record<Permission, Action>>;
export type Session = Readonly<{
  id: string;
  accountId: string;
  name: string;
  audience: "dashboard" | "operator" | "app" | "worker";
  expiresAt: string;
  visibilityKey: string;
}>;
export type Organization = Readonly<{
  id: string;
  name: string;
  revision: string;
}>;
export type Project = Readonly<{
  id: string;
  orgId: string;
  name: string;
  slug: string;
  status: "ready" | "degraded" | "archived" | "provisioning";
  mode?: "data" | "builds" | "both";
  revision: string;
}>;
export type Environment = Readonly<{
  id: string;
  projectId: string;
  name: string;
  kind: "development" | "staging" | "production";
  status: "ready" | "degraded" | "provisioning" | "paused";
  requireProductionConfirmation?: boolean;
  revision: string;
}>;
export type Binding = Readonly<{
  id: string;
  scope: Scope;
  owner: "cloud" | "database" | "registry" | "auth" | "functions";
  serviceResourceId: string;
  state: "ready" | "failed" | "pending";
}>;
export type ResolvedScope = Readonly<{
  organization: Organization;
  project?: Project;
  environment?: Environment;
  permissions: Permissions;
  bindings: readonly Binding[];
}>;
export type Capability = Readonly<{
  id: string;
  owner: "cloud" | "database" | "registry";
  available: boolean;
  reason?: string;
  limits?: Readonly<Record<string, string | number>>;
}>;
export type OperationState =
  | "queued"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled";
export type Operation = Readonly<{
  id: string;
  kind: "foundation.check" | "environment.provision" | "windows.build" | "release.publish" | "data.import" | "data.export" | "data.index" | "data.sql" | "data.extension" | "function.deploy";
  scope: Scope;
  actorId: string;
  state: OperationState;
  completedSteps: number;
  totalSteps: number;
  steps: readonly string[];
  revision: string;
  createdAt: string;
  updatedAt: string;
  requestId: string;
  error?: ServiceError;
  actions: Readonly<{ cancel: Action; retry: Action }>;
}>;
export type PlatformEvent = Readonly<{
  id: string;
  cursor: string;
  scope: Scope;
  resourceId: string;
  revision: string;
  action: string;
  actorId: string;
  occurredAt: string;
}>;
export type Audit = Readonly<{
  id: string;
  scope: Scope;
  actorId: string;
  action: string;
  resourceId: string;
  outcome: "succeeded" | "failed";
  occurredAt: string;
  requestId: string;
  metadata?: Readonly<Record<string, string>>;
}>;
export type SubscriptionMessage = Readonly<{
  state: "connected" | "gap" | "closed";
  cursor: string;
  events: readonly PlatformEvent[];
  error?: ServiceError;
}>;
export type Change = Readonly<{ security: boolean; scopes: readonly Scope[] }>;
export type Unsubscribe = () => void;

export interface BrowserServices {
  identity: import("./identity-contracts").IdentityService;
  platform: import("./identity-contracts").PlatformService;
  configuration: import("./configuration-contracts").ConfigurationService;
  delivery: import("./delivery-contracts").DeliveryService;
  data: import("./data-contracts").DataService;
  appAuth: import("./app-auth-contracts").AppAuthService;
  extensions: import("./extension-contracts").ExtensionService;
  functions: import("./function-contracts").FunctionService;
  /** Functions as the live service offers them. Present only in the production composition; the mock uses `functions`. */
  liveFunctions?: import("./live-function-contracts").LiveFunctionService;
  registry: import("./registry-contracts").RegistryService;
  billing: import("./operations-contracts").BillingService;
  operator: import("./operations-contracts").OperatorService;
  session: {
    getSession(context?: AccountContext): Promise<Result<Session | null>>;
    signOut(): Promise<Result<void>>;
    subscribe(listener: (change: Change) => void): Unsubscribe;
  };
  catalog: {
    listOrganizations(
      page?: PageRequest,
      context?: AccountContext,
    ): Promise<Result<Page<Organization>>>;
    resolveScope(context: RequestContext): Promise<Result<ResolvedScope>>;
    listProjects(
      context: RequestContext,
      page?: PageRequest,
    ): Promise<Result<Page<Project>>>;
    listEnvironments(
      context: RequestContext,
      page?: PageRequest,
    ): Promise<Result<Page<Environment>>>;
  };
  capabilities: {
    getAvailableCapabilities(
      context: RequestContext,
    ): Promise<Result<readonly Capability[]>>;
  };
  operations: {
    get(context: RequestContext, id: string): Promise<Result<Operation>>;
    list(
      context: RequestContext,
      page?: PageRequest,
    ): Promise<Result<Page<Operation>>>;
    requestCancel(
      context: RequestContext,
      id: string,
      options: CommandOptions,
    ): Promise<Result<Operation>>;
    retryAllowedStep(
      context: RequestContext,
      id: string,
      options: CommandOptions,
    ): Promise<Result<Operation>>;
  };
  activity: {
    listAudit(
      context: RequestContext,
      page?: AuditRequest,
    ): Promise<Result<Page<Audit>>>;
  };
  events: {
    subscribe(
      context: RequestContext,
      cursor: string | undefined,
      listener: (message: SubscriptionMessage) => void,
    ): Promise<Result<Unsubscribe>>;
  };
}

// Convert Result errors at the query-cache boundary only. Adapter ports never reject
// for expected service failures and never return transport Response objects.
export class ServiceFailure extends Error {
  constructor(readonly detail: ServiceError) {
    super(detail.message);
  }
}
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new ServiceFailure(result.error);
  return result.value;
}
