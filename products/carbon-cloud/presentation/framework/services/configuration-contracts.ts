import type { CommandOptions, Page, PageRequest, RequestContext, Result, Scope } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type CredentialAction = "data:read" | "data:write" | "functions:invoke" | "builds:trigger" | "releases:publish";
export type RepositoryInstallation = Readonly<{
  id: string; orgId: string; provider: "github"; account: string;
  scopes: readonly string[]; repositories: readonly string[];
  status: "connected" | "attention" | "disconnected"; connectedAt: string;
  dependentProjectIds: readonly string[]; revision: string;
}>;
export type RepositoryConfiguration = Readonly<{
  projectId: string; installationId?: string; repository?: string;
  branch: string; rootDirectory: string; pushTrigger: boolean; pullRequestTrigger: boolean;
  manifest: Readonly<{ status: "unconfigured" | "ready" | "missing" | "conflict" | "disconnected"; path?: string; message: string }>;
  proposal: Readonly<{ status: "none" | "pending" | "applied"; summary?: string }>;
  revision: string;
}>;
export type SetupTask = Readonly<{
  id: "identity" | "repository" | "api" | "table" | "build" | "release";
  name: string; status: "complete" | "action_required" | "blocked" | "upcoming";
  detail: string; href: string;
}>;
export type ProjectSettings = Readonly<{
  projectId: string; name: string; slug: string; publicId: string; revision: string;
}>;
export type EnvironmentCredential = Readonly<{
  id: string; scope: Scope; name: string; audience: "backend" | "ci";
  resources: readonly ("database" | "functions" | "builds" | "releases")[];
  actions: readonly CredentialAction[]; prefix: string; status: "active" | "expiring" | "revoked" | "expired";
  createdAt: string; expiresAt: string; lastUsedAt?: string; overlapEndsAt?: string;
  dependents: readonly string[]; revision: string;
}>;
export type SecretMetadata = Readonly<{
  id: string; scope: Scope; name: string; type: "generic" | "oauth" | "database" | "signing";
  version: number; createdAt: string; updatedAt: string; bindings: readonly string[]; revision: string;
}>;
export type ApiSettings = Readonly<{
  scope: Scope; publicProjectId: string; realmId: string;
  endpoints: Readonly<{ api: string; auth: string; realtime: string }>;
  browserConfiguration: Readonly<Record<string, string>>;
  revision: string;
}>;
export type ServiceAccount = Readonly<{
  id: string; orgId: string; name: string; status: "active" | "disabled";
  grants: readonly { scope: Scope; actions: readonly CredentialAction[] }[];
  credentialIds: readonly string[]; revision: string;
}>;
export type OrganizationCredential = Readonly<{
  id: string; orgId: string; serviceAccountId: string; name: string;
  prefix: string; status: "active" | "revoked" | "expired"; expiresAt: string;
  lastUsedAt?: string; revision: string;
}>;
export type PersonalCredential = Readonly<{
  id: string; accountId: string; name: string; scopes: readonly string[];
  prefix: string; status: "active" | "revoked" | "expired"; expiresAt: string;
  lastUsedAt?: string; affectedProjectIds: readonly string[]; revision: string;
}>;
export type DeviceGrant = Readonly<{
  id: string; accountId: string; kind: "device" | "provider"; client: string; device: string; orgId?: string;
  scopes: readonly string[]; status: "active" | "revoked"; authorizedAt: string;
  lastUsedAt?: string; affectedProjectIds: readonly string[]; revision: string;
}>;
export type DeviceRequest = Readonly<{
  code: string; client: string; device: string; orgId?: string; organization?: string;
  scopes: readonly string[]; status: "pending" | "approved" | "denied" | "expired";
  expiresAt: string; revision: string;
}>;

export type RepositoryCommand =
  | { kind: "installation-create"; account: string; repositories: string[] }
  | { kind: "installation-reconnect"; installationId: string }
  | { kind: "installation-disconnect"; installationId: string; confirmation: string }
  | { kind: "repository-save"; installationId: string; repository: string; branch: string; rootDirectory: string; pushTrigger: boolean; pullRequestTrigger: boolean }
  | { kind: "repository-clear"; confirmation: string }
  | { kind: "proposal-apply" };
export type CredentialCommand =
  | { kind: "credential-create"; name: string; audience: "backend" | "ci"; resources?: ("database" | "functions" | "builds" | "releases")[]; actions: CredentialAction[]; expiryDays: number }
  | { kind: "credential-rotate"; credentialId: string; overlapHours: number }
  | { kind: "credential-revoke"; credentialId: string };
export type SecretCommand =
  | { kind: "secret-create"; name: string; type: SecretMetadata["type"]; value: string }
  | { kind: "secret-replace"; secretId: string; value: string }
  | { kind: "secret-remove"; secretId: string };
export type ServiceAccountCommand =
  | { kind: "service-account-create"; name: string; projectId: string; environmentId?: string; actions: CredentialAction[] }
  | { kind: "service-account-disable"; serviceAccountId: string }
  | { kind: "service-account-credential"; serviceAccountId: string; name: string; expiryDays: number }
  | { kind: "organization-credential-revoke"; credentialId: string };
export type PersonalCredentialCommand =
  | { kind: "personal-credential-create"; name: string; scopes: string[]; expiryDays: number }
  | { kind: "personal-credential-revoke"; credentialId: string }
  | { kind: "device-revoke"; deviceId: string };

export interface ConfigurationService {
  getProjectSettings(context: RequestContext): Promise<Result<ProjectSettings>>;
  updateProjectSettings(context: RequestContext, input: { name: string; slug: string }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getSetupChecklist(context: RequestContext): Promise<Result<readonly SetupTask[]>>;
  listRepositoryInstallations(context: RequestContext, page?: PageRequest): Promise<Result<Page<RepositoryInstallation>>>;
  getRepository(context: RequestContext): Promise<Result<RepositoryConfiguration>>;
  repositoryCommand(context: RequestContext, input: RepositoryCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getApiSettings(context: RequestContext): Promise<Result<ApiSettings>>;
  listEnvironmentCredentials(context: RequestContext, page?: PageRequest): Promise<Result<Page<EnvironmentCredential>>>;
  credentialCommand(context: RequestContext, input: CredentialCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listSecrets(context: RequestContext, page?: PageRequest): Promise<Result<Page<SecretMetadata>>>;
  secretCommand(context: RequestContext, input: SecretCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listServiceAccounts(context: RequestContext, page?: PageRequest): Promise<Result<Page<ServiceAccount>>>;
  listOrganizationCredentials(context: RequestContext, page?: PageRequest): Promise<Result<Page<OrganizationCredential>>>;
  serviceAccountCommand(context: RequestContext, input: ServiceAccountCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listPersonalCredentials(page?: PageRequest): Promise<Result<Page<PersonalCredential>>>;
  listDeviceGrants(page?: PageRequest): Promise<Result<Page<DeviceGrant>>>;
  personalCredentialCommand(input: PersonalCredentialCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getDeviceRequest(code: string): Promise<Result<DeviceRequest>>;
  respondDeviceRequest(code: string, approve: boolean, options: CommandOptions): Promise<Result<CommandReceipt>>;
}
