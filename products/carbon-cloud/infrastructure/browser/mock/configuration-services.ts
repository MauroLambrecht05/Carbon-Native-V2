import type { CommandOptions, PageRequest, RequestContext, Result, Scope } from "../../../presentation/framework/services/contracts";
import type { ConfigurationService, CredentialAction, RepositoryCommand } from "../../../presentation/framework/services/configuration-contracts";
import type { CommandReceipt } from "../../../presentation/framework/services/identity-contracts";
import { containsScope, Refusal, requirePermission, requireSession, resolveScope } from "./access";
import { now } from "./clock";
import { allocate, bump, identityState } from "./identity-state";
import { configurationState } from "./configuration-state";
import { deliveryState } from "./delivery-state";
import { dataState } from "./data-state";
import { paginate } from "./pagination";
import type { MockState } from "./store";

type Run = <T>(execute: (state: MockState, requestId: string) => T, config?: {
  signal?: AbortSignal; mutate?: boolean; fast?: boolean;
  audit?: { scope: Scope; action: string; resourceId?: string };
}) => Promise<Result<T>>;

const allowedCredentialActions: readonly CredentialAction[] = ["data:read", "data:write", "functions:invoke", "builds:trigger", "releases:publish"];
const personalScopes = ["profile:read", "projects:read", "builds:trigger"] as const;
const required = (value: string, label: string, max = 100) => {
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Refusal("validation", `${label} must be 1-${max} characters.`);
  return clean;
};
const revision = (current: string, options: CommandOptions) => {
  if (options.expectedRevision !== current) throw new Refusal("conflict", "This resource changed. Reload and compare the latest revision before saving.");
};
const expiry = (state: MockState, wall: number, days: number) => {
  if (![1, 7, 30, 90, 365].includes(days)) throw new Refusal("validation", "Choose an expiry from 1 day to 1 year.");
  return new Date(now(state.clock, wall) + days * 86_400_000).toISOString();
};
const validateActions = (actions: readonly string[]) => {
  const unique = [...new Set(actions)] as CredentialAction[];
  if (!unique.length || unique.some(action => !allowedCredentialActions.includes(action))) throw new Refusal("validation", "Choose at least one supported credential action.");
  return unique;
};
const scopeFingerprint = (scope: Scope) => JSON.stringify([scope.orgId, scope.projectId ?? null, scope.environmentId ?? null]);
const secretFingerprint = (value: string) => {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `redacted:${(hash >>> 0).toString(16)}`;
};
function executeOnce<T>(state: MockState, scope: Scope | undefined, command: string, payload: unknown, options: CommandOptions, execute: () => T): T {
  if (!options.idempotencyKey?.trim() || options.idempotencyKey.length > 200) throw new Refusal("validation", "An idempotency key of 1-200 characters is required.");
  const actorId = state.activeSessionId ? state.sessions[state.activeSessionId]?.accountId : undefined;
  if (!actorId) throw new Refusal("unauthenticated", "Sign in to continue.");
  const key = JSON.stringify([actorId, scope ? scopeFingerprint(scope) : "account", command, options.idempotencyKey]);
  const fingerprint = JSON.stringify([payload, options.expectedRevision ?? null]);
  const prior = state.idempotency[key];
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Refusal("conflict", "This idempotency key was used with different input.");
    return structuredClone(prior.value) as T;
  }
  const value = execute();
  state.idempotency[key] = { fingerprint, value: structuredClone(value) };
  return value;
}
function audit(state: MockState, scope: Scope, actorId: string, action: string, resourceId: string, requestId: string, wall: number, metadata?: Record<string, string>) {
  const occurredAt = new Date(now(state.clock, wall)).toISOString();
  const id = allocate(state, "audit");
  state.audits[id] = { id, scope, actorId, action, resourceId, outcome: "succeeded", occurredAt, requestId, ...(metadata ? { metadata } : {}) };
  const cursor = String(++state.sequence);
  state.events[`event_${cursor}`] = { id: `event_${cursor}`, cursor, scope, actorId, action, resourceId, revision: "r1", occurredAt };
}
function secretValue(prefix: string) {
  return `${prefix}.${crypto.randomUUID().replaceAll("-", "")}`;
}
function accountProjects(state: MockState, accountId: string) {
  const ids = new Set<string>();
  for (const membership of Object.values(state.memberships).filter(item => item.active && item.accountId === accountId)) {
    if (["Owner", "Admin"].includes(membership.role)) Object.values(state.projects).filter(project => project.orgId === membership.orgId).forEach(project => ids.add(project.id));
    else membership.projects.forEach(projectId => ids.add(projectId));
  }
  return [...ids];
}

export function createConfigurationServices(run: Run, wallTime: () => number): ConfigurationService {
  const withContext = (context: RequestContext, permission: "metadata.read" | "resources.configure" | "organization.manage" = "metadata.read") => (state: MockState) => {
    const resolved = requirePermission(state, context.scope, permission, wallTime());
    return { state, resolved, data: configurationState(state), actor: requireSession(state, wallTime()) };
  };
  return {
    getProjectSettings: context => run(state => {
      const { resolved } = withContext(context)(state);
      if (!resolved.project || context.scope.environmentId) throw new Refusal("validation", "Select a project.");
      return { projectId: resolved.project.id, name: resolved.project.name, slug: resolved.project.slug, publicId: `carbon_${resolved.project.id}`, revision: resolved.project.revision };
    }, { signal: context.signal }),
    updateProjectSettings: (context, input, options) => run((state, requestId) => {
      const { resolved, actor } = withContext(context, "resources.configure")(state);
      if (!resolved.project || context.scope.environmentId) throw new Refusal("validation", "Select a project.");
      return executeOnce(state, context.scope, "project.update", input, options, () => {
        revision(resolved.project!.revision, options);
        const name = required(input.name, "Project name");
        const slug = required(input.slug, "Project slug", 64).toLowerCase();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Refusal("validation", "Project slug must use lowercase letters, numbers and single hyphens.");
        if (Object.values(state.projects).some(item => item.id !== resolved.project!.id && item.orgId === context.scope.orgId && item.slug === slug)) throw new Refusal("conflict", "Project slug is already used in this organization.");
        Object.assign(state.projects[resolved.project!.id], { name, slug, revision: bump(resolved.project!.revision) });
        audit(state, context.scope, actor.accountId, "project.settings.updated", resolved.project!.id, requestId, wallTime(), { fields: "name,slug" });
        return { message: "Project settings saved.", resourceId: resolved.project!.id };
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: "project.settings.update.refused" } }),
    getSetupChecklist: context => run(state => {
      const { resolved, data } = withContext(context)(state);
      if (!resolved.project || context.scope.environmentId) throw new Refusal("validation", "Select a project.");
      const base = `/orgs/${context.scope.orgId}/projects/${resolved.project.id}`;
      const repository = data.repositories[resolved.project.id];
      const environments = Object.values(state.environments).filter(item => item.projectId === resolved.project!.id);
      const hasCredential = Object.values(data.environmentCredentials).some(item => item.scope.projectId === resolved.project!.id && ["active", "expiring"].includes(item.status));
      const delivery = deliveryState(state);
      const built = Object.values(delivery.builds).some(b => b.scope.projectId === resolved.project!.id && b.status === "succeeded");
      const published = Object.values(delivery.releases).some(r => r.scope.projectId === resolved.project!.id && r.status === "published");
      const hasTable = Object.values(dataState(state).tables).some(t => t.scope.projectId === resolved.project!.id);
      return [
        { id: "identity", name: "Project and environments", status: "complete", detail: `${environments.length} isolated environment${environments.length === 1 ? "" : "s"} provisioned.`, href: `${base}/settings/environments` },
        { id: "repository", name: "Repository", status: repository.manifest.status === "ready" ? "complete" : "action_required", detail: repository.manifest.message, href: `${base}/settings/repository` },
        { id: "api", name: "API access", status: hasCredential ? "complete" : "action_required", detail: hasCredential ? "At least one environment has an active server credential." : "Public client settings are ready; create a scoped server credential if your backend needs one.", href: environments[0] ? `${base}/environments/${environments[0].id}/settings/api` : `${base}/settings/environments` },
        { id: "table", name: "First table", status: hasTable ? "complete" : "action_required", detail: hasTable ? "Relational schema and policy-aware row workflows are available." : "Enable Database resources in an environment, then create a table and owner policy.", href: environments[0] ? `${base}/environments/${environments[0].id}/database/tables` : `${base}/settings/environments` },
        { id: "build", name: "First Windows build", status: built ? "complete" : repository.manifest.status === "ready" ? "action_required" : "blocked", detail: built ? "A successful Windows build and immutable artifacts are available." : repository.manifest.status === "ready" ? "Review preflight and queue a Windows build." : "Resolve repository setup before a build can run.", href: `${base}/builds` },
        { id: "release", name: "First release", status: published ? "complete" : built ? "action_required" : "blocked", detail: published ? "A release is published; channel pointers and delivery evidence are tracked separately." : built ? "Create a draft and review publication readiness." : "Complete a successful build first.", href: `${base}/releases` },
      ] as const;
    }, { signal: context.signal }),
    listRepositoryInstallations: (context, page) => run(state => {
      const { data } = withContext({ ...context, scope: { orgId: context.scope.orgId } })(state);
      return paginate(Object.values(data.installations).filter(item => item.orgId === context.scope.orgId), page, `${requireSession(state, wallTime()).visibilityKey}:${context.scope.orgId}:installations`);
    }, { signal: context.signal }),
    getRepository: context => run(state => {
      const { resolved, data } = withContext(context)(state);
      if (!resolved.project || context.scope.environmentId) throw new Refusal("validation", "Select a project.");
      return data.repositories[resolved.project.id];
    }, { signal: context.signal }),
    repositoryCommand: (context, input, options) => run((state, requestId) => {
      const installationCommand = input.kind.startsWith("installation-");
      const commandScope = installationCommand ? { orgId: context.scope.orgId } : context.scope;
      const { resolved, data, actor } = withContext({ ...context, scope: commandScope }, installationCommand ? "organization.manage" : "resources.configure")(state);
      return executeOnce(state, commandScope, input.kind, input, options, () => {
        let resourceId = resolved.project?.id ?? context.scope.orgId;
        if (input.kind === "installation-create") {
          const account = required(input.account, "Provider account");
          const repositories = [...new Set(input.repositories.map(item => item.trim()).filter(Boolean))];
          if (!repositories.length || repositories.some(item => !/^[\w.-]+\/[\w.-]+$/.test(item))) throw new Refusal("validation", "Enter at least one repository as owner/name.");
          const id = allocate(state, "installation");
          data.installations[id] = { id, orgId: context.scope.orgId, provider: "github", account, scopes: ["metadata:read", "contents:read"], repositories, status: "connected", connectedAt: new Date(now(state.clock, wallTime())).toISOString(), dependentProjectIds: [], revision: "r1" };
          resourceId = id;
        } else if (input.kind === "installation-reconnect" || input.kind === "installation-disconnect") {
          const item = data.installations[input.installationId];
          if (!item || item.orgId !== context.scope.orgId) throw new Refusal("not_found", "Repository installation not found.");
          revision(item.revision, options);
          if (input.kind === "installation-disconnect") {
            if (item.dependentProjectIds.length && input.confirmation !== item.id) throw new Refusal("validation", `Type ${item.id} to disconnect ${item.dependentProjectIds.length} dependent project(s).`);
            Object.assign(item, { status: "disconnected", revision: bump(item.revision) });
            for (const repo of Object.values(data.repositories).filter(repo => repo.installationId === item.id)) Object.assign(repo, { manifest: { status: "disconnected", message: "The organization repository connection was disconnected." }, revision: bump(repo.revision) });
          } else {
            Object.assign(item, { status: "connected", connectedAt: new Date(now(state.clock, wallTime())).toISOString(), revision: bump(item.revision) });
            for (const repo of Object.values(data.repositories).filter(repo => repo.installationId === item.id && repo.manifest.status === "disconnected")) {
              const path = repo.rootDirectory === "." ? "carbon.json" : `${repo.rootDirectory}/carbon.json`;
              Object.assign(repo, { manifest: { status: "ready", path, message: `Repository access restored; Carbon manifest found at ${path}.` }, proposal: { status: "pending", summary: "Review the restored repository configuration before the next build." }, revision: bump(repo.revision) });
            }
          }
          resourceId = item.id;
        } else {
          if (!resolved.project || context.scope.environmentId) throw new Refusal("validation", "Select a project.");
          const repo = data.repositories[resolved.project.id];
          revision(repo.revision, options);
          if (input.kind === "repository-clear") {
            if (input.confirmation !== (repo.repository ?? resolved.project.name)) throw new Refusal("validation", "Type the current repository name to remove the binding.");
            Object.assign(repo, { installationId: undefined, repository: undefined, manifest: { status: "unconfigured", message: "Choose an organization repository connection to begin." }, proposal: { status: "none" }, revision: bump(repo.revision) });
          } else if (input.kind === "proposal-apply") {
            if (repo.proposal.status !== "pending" || repo.manifest.status !== "ready") throw new Refusal("conflict", "There is no ready configuration proposal to apply.");
            Object.assign(repo, { proposal: { ...repo.proposal, status: "applied" }, revision: bump(repo.revision) });
          } else {
            const installation = data.installations[input.installationId];
            if (!installation || installation.orgId !== context.scope.orgId) throw new Refusal("not_found", "Repository installation not found.");
            if (installation.status !== "connected") throw new Refusal("conflict", "Reconnect the repository installation before saving this project.");
            const repository = required(input.repository, "Repository");
            if (!installation.repositories.includes(repository)) throw new Refusal("forbidden", "The selected installation does not grant access to this repository.");
            const branch = required(input.branch, "Default branch", 120);
            const rootDirectory = input.rootDirectory.trim() || ".";
            if (rootDirectory.startsWith("/") || rootDirectory.includes("..")) throw new Refusal("validation", "Root directory must be a relative repository path without parent traversal.");
            const status = repository.toLowerCase().includes("missing") || rootDirectory.toLowerCase().includes("missing") ? "missing" : rootDirectory.toLowerCase().includes("conflict") ? "conflict" : "ready";
            const message = status === "missing" ? "No Carbon manifest was found under the selected directory." : status === "conflict" ? "Repository configuration conflicts with the saved dashboard settings." : `Carbon manifest found at ${rootDirectory === "." ? "carbon.json" : `${rootDirectory}/carbon.json`}.`;
            Object.assign(repo, { installationId: installation.id, repository, branch, rootDirectory, pushTrigger: input.pushTrigger, pullRequestTrigger: input.pullRequestTrigger, manifest: { status, ...(status === "ready" ? { path: rootDirectory === "." ? "carbon.json" : `${rootDirectory}/carbon.json` } : {}), message }, proposal: status === "ready" ? { status: "pending", summary: `Use ${branch} from ${repository}; build root ${rootDirectory}.` } : { status: "none" }, revision: bump(repo.revision) });
          }
          resourceId = repo.projectId;
        }
        audit(state, commandScope, actor.accountId, input.kind, resourceId, requestId, wallTime(), { provider: "github" });
        return { message: input.kind === "proposal-apply" ? "Repository configuration proposal applied locally." : "Repository configuration saved.", resourceId };
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: `${input.kind}.refused` } }),
    getApiSettings: context => run(state => {
      const { resolved } = withContext(context)(state);
      if (!resolved.environment) throw new Refusal("validation", "Select an environment.");
      const base = `https://api.mock.carbon.invalid/v1/${resolved.project!.id}/${resolved.environment.id}`;
      return { scope: context.scope, publicProjectId: `carbon_${resolved.project!.id}`, realmId: `realm_${resolved.environment.id}`, endpoints: { api: base, auth: `${base}/auth`, realtime: `wss://realtime.mock.carbon.invalid/${resolved.environment.id}` }, browserConfiguration: { projectId: `carbon_${resolved.project!.id}`, environment: resolved.environment.id, apiUrl: base }, revision: resolved.environment.revision };
    }, { signal: context.signal }),
    listEnvironmentCredentials: (context, page) => run(state => {
      const { data } = withContext(context, "resources.configure")(state);
      if (!context.scope.environmentId) throw new Refusal("validation", "Select an environment.");
      return paginate(Object.values(data.environmentCredentials).filter(item => item.scope.environmentId === context.scope.environmentId), page, `${requireSession(state, wallTime()).visibilityKey}:${scopeFingerprint(context.scope)}:credentials`);
    }, { signal: context.signal }),
    credentialCommand: (context, input, options) => run((state, requestId) => {
      const { resolved, data, actor } = withContext(context, "resources.configure")(state);
      if (!resolved.environment) throw new Refusal("validation", "Select an environment.");
      return executeOnce(state, context.scope, input.kind, input, options, () => {
        let receipt: CommandReceipt;
        if (input.kind === "credential-create") {
          const actions = validateActions(input.actions);
          const requiredResources: Record<CredentialAction, string> = { "data:read": "database", "data:write": "database", "functions:invoke": "functions", "builds:trigger": "builds", "releases:publish": "releases" };
          const resources = [...new Set(input.resources ?? actions.map(action => requiredResources[action]))] as ("database" | "functions" | "builds" | "releases")[];
          if (!resources.length || resources.some(resource => !["database", "functions", "builds", "releases"].includes(resource))) throw new Refusal("validation", "Choose at least one supported resource scope.");
          if (actions.some(action => !resources.includes(requiredResources[action] as typeof resources[number]))) throw new Refusal("validation", "Every action must match one of the selected resource scopes.");
          if (actions.includes("data:read") && !resolved.permissions["data.read"].allowed) throw new Refusal("forbidden", "This actor cannot grant data read access they do not hold.");
          if (actions.includes("data:write") && !resolved.permissions["data.write"].allowed) throw new Refusal("forbidden", "This actor cannot grant data write access they do not hold.");
          if (actions.includes("releases:publish") && !resolved.permissions["release.publish"].allowed) throw new Refusal("forbidden", "This actor cannot grant release publishing access they do not hold.");
          if (!(["Owner", "Admin"].includes(Object.values(state.memberships).find(item => item.active && item.orgId === context.scope.orgId && item.accountId === actor.accountId)!.role)) && actions.includes("releases:publish")) throw new Refusal("forbidden", "Release publishing requires an explicit production grant and cannot be added by this actor.");
          const id = allocate(state, "credential"), prefix = `cc_env_${id.slice(-4).toUpperCase()}`;
          data.environmentCredentials[id] = { id, scope: context.scope, name: required(input.name, "Credential name"), audience: input.audience, resources, actions, prefix, status: "active", createdAt: new Date(now(state.clock, wallTime())).toISOString(), expiresAt: expiry(state, wallTime(), input.expiryDays), dependents: input.audience === "ci" ? ["CI workflow (unverified metadata)"] : [], revision: "r1" };
          receipt = { message: "Credential created. Copy the fake secret now; only its prefix will remain.", secretValue: secretValue(prefix), resourceId: id };
        } else {
          const item = data.environmentCredentials[input.credentialId];
          if (!item || !containsScope(context.scope, item.scope)) throw new Refusal("not_found", "Credential not found.");
          revision(item.revision, options);
          if (item.status === "revoked" || item.status === "expired") throw new Refusal("conflict", "This credential is no longer active.");
          if (input.kind === "credential-revoke") {
            Object.assign(item, { status: "revoked", revision: bump(item.revision) });
            receipt = { message: item.dependents.length ? `Credential revoked. Review ${item.dependents.length} dependent integration(s).` : "Credential revoked.", resourceId: item.id };
          } else {
            if (![0, 1, 24].includes(input.overlapHours)) throw new Refusal("validation", "Overlap must be immediate, 1 hour or 24 hours.");
            const id = allocate(state, "credential"), prefix = `cc_env_${id.slice(-4).toUpperCase()}`;
            Object.assign(item, { status: input.overlapHours ? "expiring" : "revoked", ...(input.overlapHours ? { overlapEndsAt: new Date(now(state.clock, wallTime()) + input.overlapHours * 3_600_000).toISOString() } : {}), revision: bump(item.revision) });
            data.environmentCredentials[id] = { ...item, id, prefix, status: "active", createdAt: new Date(now(state.clock, wallTime())).toISOString(), expiresAt: expiry(state, wallTime(), 90), overlapEndsAt: undefined, revision: "r1" };
            receipt = { message: input.overlapHours ? `Credential rotated with ${input.overlapHours}-hour overlap.` : "Credential rotated immediately.", secretValue: secretValue(prefix), resourceId: id };
          }
        }
        audit(state, context.scope, actor.accountId, input.kind, receipt.resourceId!, requestId, wallTime(), { secret: "redacted" });
        return receipt;
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: `${input.kind}.refused` } }),
    listSecrets: (context, page) => run(state => {
      const { data } = withContext(context, "resources.configure")(state);
      if (!context.scope.environmentId) throw new Refusal("validation", "Select an environment.");
      return paginate(Object.values(data.secrets).filter(item => item.scope.environmentId === context.scope.environmentId), page, `${requireSession(state, wallTime()).visibilityKey}:${scopeFingerprint(context.scope)}:secrets`);
    }, { signal: context.signal }),
    secretCommand: (context, input, options) => run((state, requestId) => {
      const { resolved, data, actor } = withContext(context, "resources.configure")(state);
      if (!resolved.environment) throw new Refusal("validation", "Select an environment.");
      return executeOnce(state, context.scope, input.kind, { ...input, ...("value" in input ? { value: secretFingerprint(input.value) } : {}) }, options, () => {
        let item;
        if (input.kind === "secret-create") {
          const name = required(input.name, "Secret name", 80).toUpperCase();
          if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Refusal("validation", "Secret names use uppercase letters, numbers and underscores.");
          if (Object.values(data.secrets).some(value => value.scope.environmentId === context.scope.environmentId && value.name === name)) throw new Refusal("conflict", "A secret with this name already exists in the environment.");
          required(input.value, "Secret value", 200);
          const id = allocate(state, "secret"), time = new Date(now(state.clock, wallTime())).toISOString();
          item = data.secrets[id] = { id, scope: context.scope, name, type: input.type, version: 1, createdAt: time, updatedAt: time, bindings: [], revision: "r1" };
        } else {
          item = data.secrets[input.secretId];
          if (!item || !containsScope(context.scope, item.scope)) throw new Refusal("not_found", "Secret metadata not found.");
          revision(item.revision, options);
          if (input.kind === "secret-remove") {
            if (item.bindings.length) throw new Refusal("conflict", `Rebind or disable ${item.bindings.length} dependent resource(s) before removing this secret.`);
            delete data.secrets[item.id];
          } else {
            required(input.value, "Secret value", 200);
            Object.assign(item, { version: item.version + 1, updatedAt: new Date(now(state.clock, wallTime())).toISOString(), revision: bump(item.revision) });
          }
        }
        audit(state, context.scope, actor.accountId, input.kind, item.id, requestId, wallTime(), { name: item.name, value: "redacted" });
        return { message: input.kind === "secret-create" ? "Secret stored. Only metadata is available after this response." : input.kind === "secret-replace" ? "Secret replaced; the prior value is no longer available." : "Secret removed.", resourceId: item.id };
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: `${input.kind}.refused` } }),
    listServiceAccounts: (context, page) => run(state => {
      const { data } = withContext({ ...context, scope: { orgId: context.scope.orgId } }, "organization.manage")(state);
      return paginate(Object.values(data.serviceAccounts).filter(item => item.orgId === context.scope.orgId), page, `${requireSession(state, wallTime()).visibilityKey}:${context.scope.orgId}:service-accounts`);
    }, { signal: context.signal }),
    listOrganizationCredentials: (context, page) => run(state => {
      const { data } = withContext({ ...context, scope: { orgId: context.scope.orgId } }, "organization.manage")(state);
      return paginate(Object.values(data.organizationCredentials).filter(item => item.orgId === context.scope.orgId), page, `${requireSession(state, wallTime()).visibilityKey}:${context.scope.orgId}:organization-credentials`);
    }, { signal: context.signal }),
    serviceAccountCommand: (context, input, options) => run((state, requestId) => {
      const scope = { orgId: context.scope.orgId };
      const { data, actor } = withContext({ ...context, scope }, "organization.manage")(state);
      return executeOnce(state, scope, input.kind, input, options, () => {
        let resourceId: string, receipt: CommandReceipt;
        if (input.kind === "service-account-create") {
          const project = state.projects[input.projectId];
          if (!project || project.orgId !== scope.orgId) throw new Refusal("not_found", "Project not found.");
          if (input.environmentId && state.environments[input.environmentId]?.projectId !== project.id) throw new Refusal("validation", "Environment does not belong to the selected project.");
          const id = allocate(state, "service_account");
          data.serviceAccounts[id] = { id, orgId: scope.orgId, name: required(input.name, "Service account name"), status: "active", grants: [{ scope: { ...scope, projectId: project.id, ...(input.environmentId ? { environmentId: input.environmentId } : {}) }, actions: validateActions(input.actions) }], credentialIds: [], revision: "r1" };
          resourceId = id; receipt = { message: "Service account created with the selected narrow grant.", resourceId };
        } else if (input.kind === "organization-credential-revoke") {
          const credential = data.organizationCredentials[input.credentialId];
          if (!credential || credential.orgId !== scope.orgId) throw new Refusal("not_found", "Organization credential not found.");
          revision(credential.revision, options); Object.assign(credential, { status: "revoked", revision: bump(credential.revision) });
          resourceId = credential.id; receipt = { message: "Organization credential revoked.", resourceId };
        } else {
          const account = data.serviceAccounts[input.serviceAccountId];
          if (!account || account.orgId !== scope.orgId) throw new Refusal("not_found", "Service account not found.");
          revision(account.revision, options);
          if (input.kind === "service-account-disable") {
            Object.assign(account, { status: "disabled", revision: bump(account.revision) });
            for (const credentialId of account.credentialIds) if (data.organizationCredentials[credentialId]) Object.assign(data.organizationCredentials[credentialId], { status: "revoked", revision: bump(data.organizationCredentials[credentialId].revision) });
            resourceId = account.id; receipt = { message: `Service account disabled and ${account.credentialIds.length} credential(s) revoked.`, resourceId };
          } else {
            if (account.status !== "active") throw new Refusal("conflict", "Enable or replace the service account before issuing a credential.");
            const id = allocate(state, "org_credential"), prefix = `cc_org_${id.slice(-4).toUpperCase()}`;
            data.organizationCredentials[id] = { id, orgId: scope.orgId, serviceAccountId: account.id, name: required(input.name, "Credential name"), prefix, status: "active", expiresAt: expiry(state, wallTime(), input.expiryDays), revision: "r1" };
            Object.assign(account, { credentialIds: [...account.credentialIds, id], revision: bump(account.revision) });
            resourceId = id; receipt = { message: "Credential issued. Copy the fake secret now; it will not be shown again.", secretValue: secretValue(prefix), resourceId };
          }
        }
        audit(state, scope, actor.accountId, input.kind, resourceId, requestId, wallTime(), { secret: "redacted" });
        return receipt;
      });
    }, { signal: context.signal, mutate: true, audit: { scope: { orgId: context.scope.orgId }, action: `${input.kind}.refused` } }),
    listPersonalCredentials: page => run(state => {
      const actor = requireSession(state, wallTime()), data = configurationState(state);
      return paginate(Object.values(data.personalCredentials).filter(item => item.accountId === actor.accountId), page, `${actor.visibilityKey}:personal-credentials`);
    }),
    listDeviceGrants: page => run(state => {
      const actor = requireSession(state, wallTime()), data = configurationState(state);
      return paginate(Object.values(data.deviceGrants).filter(item => item.accountId === actor.accountId), page, `${actor.visibilityKey}:device-grants`);
    }),
    personalCredentialCommand: (input, options) => run((state, requestId) => {
      const actor = requireSession(state, wallTime()), data = configurationState(state);
      return executeOnce(state, undefined, input.kind, input, options, () => {
        if (input.kind === "personal-credential-create") {
          const scopes = [...new Set(input.scopes)];
          if (!scopes.length || scopes.some(scope => !personalScopes.includes(scope as typeof personalScopes[number]))) throw new Refusal("validation", "Choose at least one supported personal scope.");
          const projects = accountProjects(state, actor.accountId);
          if (scopes.includes("builds:trigger") && !projects.some(projectId => { try { return resolveScope(state, { orgId: state.projects[projectId].orgId, projectId }, wallTime()).permissions["resources.configure"].allowed; } catch { return false; } })) throw new Refusal("forbidden", "This account cannot trigger builds in any assigned project.");
          const id = allocate(state, "personal_credential"), prefix = `cc_pat_${id.slice(-4).toUpperCase()}`;
          data.personalCredentials[id] = { id, accountId: actor.accountId, name: required(input.name, "Token name"), scopes, prefix, status: "active", expiresAt: expiry(state, wallTime(), input.expiryDays), affectedProjectIds: projects, revision: "r1" };
          const auditId = allocate(state, "account_audit");
          identityState(state).accountAudit[auditId] = { id: auditId, accountId: actor.accountId, action: "personal-credential.created", at: new Date(now(state.clock, wallTime())).toISOString(), requestId };
          return { message: "Personal token created. Copy the fake secret now; it will not be shown again.", secretValue: secretValue(prefix), resourceId: id };
        }
        if (input.kind === "personal-credential-revoke") {
          const item = data.personalCredentials[input.credentialId];
          if (!item || item.accountId !== actor.accountId) throw new Refusal("not_found", "Personal token not found.");
          revision(item.revision, options); Object.assign(item, { status: "revoked", revision: bump(item.revision) });
          const auditId = allocate(state, "account_audit");
          identityState(state).accountAudit[auditId] = { id: auditId, accountId: actor.accountId, action: "personal-credential.revoked", at: new Date(now(state.clock, wallTime())).toISOString(), requestId };
          return { message: `Personal token revoked. ${item.affectedProjectIds.length} affected project(s) are listed in its metadata.`, resourceId: item.id };
        }
        const item = data.deviceGrants[input.deviceId];
        if (!item || item.accountId !== actor.accountId) throw new Refusal("not_found", "Device grant not found.");
        revision(item.revision, options); Object.assign(item, { status: "revoked", revision: bump(item.revision) });
        const auditId = allocate(state, "account_audit");
        identityState(state).accountAudit[auditId] = { id: auditId, accountId: actor.accountId, action: `${item.kind}.revoked`, at: new Date(now(state.clock, wallTime())).toISOString(), requestId };
        return { message: `${item.kind === "provider" ? "Provider integration" : "Device grant"} revoked. ${item.affectedProjectIds.length} affected project(s) are listed in its metadata.`, resourceId: item.id };
      });
    }, { mutate: true }),
    getDeviceRequest: code => run(state => {
      requireSession(state, wallTime());
      const item = configurationState(state).deviceRequests[code.trim().toUpperCase()];
      if (!item) throw new Refusal("not_found", "Device code not found.");
      return item;
    }),
    respondDeviceRequest: (code, approve, options) => run((state, requestId) => {
      const actor = requireSession(state, wallTime()), data = configurationState(state);
      const normalized = code.trim().toUpperCase(), item = data.deviceRequests[normalized];
      if (!item) throw new Refusal("not_found", "Device code not found.");
      return executeOnce(state, undefined, "device.respond", { code: normalized, approve }, options, () => {
        revision(item.revision, options);
        if (item.status !== "pending") throw new Refusal("conflict", `This device request is already ${item.status}.`);
        if (Date.parse(item.expiresAt) <= now(state.clock, wallTime())) throw new Refusal("conflict", "This device code expired. Start authorization again from the CLI.");
        if (item.orgId) resolveScope(state, { orgId: item.orgId }, wallTime());
        if (approve && item.scopes.includes("builds:trigger") && !accountProjects(state, actor.accountId).some(projectId => { try { return resolveScope(state, { orgId: state.projects[projectId].orgId, projectId }, wallTime()).permissions["resources.configure"].allowed; } catch { return false; } })) throw new Refusal("forbidden", "This account cannot approve the requested build scope.");
        Object.assign(item, { status: approve ? "approved" : "denied", revision: bump(item.revision) });
        if (approve) {
          const id = allocate(state, "device");
          data.deviceGrants[id] = { id, accountId: actor.accountId, kind: "device", client: item.client, device: item.device, ...(item.orgId ? { orgId: item.orgId } : {}), scopes: item.scopes, status: "active", authorizedAt: new Date(now(state.clock, wallTime())).toISOString(), affectedProjectIds: item.orgId ? accountProjects(state, actor.accountId).filter(projectId => state.projects[projectId].orgId === item.orgId) : [], revision: "r1" };
        }
        const auditId = allocate(state, "account_audit");
        identityState(state).accountAudit[auditId] = { id: auditId, accountId: actor.accountId, action: approve ? "device.approved" : "device.denied", at: new Date(now(state.clock, wallTime())).toISOString(), requestId };
        return { message: approve ? "Device authorized once with the reviewed scopes." : "Device request denied.", resourceId: normalized };
      });
    }, { mutate: true }),
  };
}
