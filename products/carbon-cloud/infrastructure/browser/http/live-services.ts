// Browser services over the real Carbon Cloud API.
//
// This is the production counterpart of the mock services. It imports nothing
// from the mock, and it has no fallback: an area the live API does not serve
// yet answers `unsupported_operation`, and the page shows that.
//
// Connected so far: the session, account, organizations, members,
// invitations, the project and environment catalog, and the audit list.

import type { AccountContext, Audit, AuditRequest, BrowserServices, Capability, Change, CommandOptions, Environment, Organization, Page, PageRequest, Permission, Permissions, Project, RequestContext, ResolvedScope, Result, Scope, Session,
  Unsubscribe } from "../../../presentation/framework/services/contracts";
import type { Account, AccountCommand, AccountSession, AuthRequest, CommandReceipt, IdentityService, Invitation, Member, OrganizationDetails, PlatformCommand, PlatformService } from "../../../presentation/framework/services/identity-contracts";
import type { LiveExecution, LiveExecutionLogs, LiveFunction, LiveFunctionDetails, LiveFunctionService, LiveSchedule } from "../../../presentation/framework/services/live-function-contracts";
import { API, LiveTransport, failure, pageQuery, unsupported, type LiveTransportOptions } from "./transport.ts";

type Json = Record<string, any>;
const PERMISSIONS: readonly Permission[] = ["organization.manage", "members.manage", "projects.create", "metadata.read", "resources.configure", "data.read", "data.write", "release.publish", "build.cancel.any", "signing.manage", "billing.manage", "audit.read"];
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
/** Carries a failure through unchanged, or maps a success. */
const then = <A, B>(result: Result<A>, map: (value: A) => B): Result<B> => (result.ok ? ok(map(result.value)) : result);
/** The live API returns one page and a cursor, with no total and no server-side name filter. The filter is applied to the page that came back. */
function pageOf<T extends { name?: string }>(items: readonly T[], nextCursor: string | null, request?: PageRequest): Page<T> {
  const name = request?.filter?.name?.trim().toLowerCase(); const kept = name ? items.filter(item => item.name?.toLowerCase().includes(name)) : items;
  return { items: kept, nextCursor, total: kept.length };
}
const orgPath = (scope: Scope) => `${API}/orgs/${scope.orgId}`;
const projectPath = (scope: Scope) => `${orgPath(scope)}/projects/${scope.projectId}`;
const environmentPath = (scope: Scope) => `${projectPath(scope)}/environments/${scope.environmentId}`;

function project(row: Json): Project {
  return { id: row.id, orgId: row.orgId, name: row.name, slug: row.slug, status: row.state === "active" ? "ready" : "archived", revision: row.revision };
}
function environment(row: Json): Environment {
  const status = row.state === "paused" ? "paused" : row.provisioning === "ready" ? "ready" : row.provisioning === "pending" ? "provisioning" : "degraded";
  return { id: row.id, projectId: row.projectId, name: row.name, kind: row.kind, status, revision: row.revision };
}

/** Everything the live API does not serve to the browser yet. Each call answers `unsupported_operation`; none of them invents data. */
function notConnected<T extends object>(area: string): T {
  return new Proxy({}, { get: (_target, property) => (typeof property === "string" ? async () => unsupported(area) : undefined) }) as T;
}

export function createLiveServices(options: LiveTransportOptions = {}): { services: BrowserServices; transport: LiveTransport } {
  const http = new LiveTransport(options);
  const listeners = new Set<(change: Change) => void>(); let known = false;
  const securityChanged = () => { for (const listener of listeners) listener({ security: true, scopes: [] }); };
  // The server ended a session this page believed it had: drop what the page holds and ask again. Said once, not on every refused request after it.
  http.onUnauthenticated(() => { if (known) { known = false; securityChanged(); } });

  const session: BrowserServices["session"] = {
    async getSession(context?: AccountContext): Promise<Result<Session | null>> {
      const result = await http.get<{ session: Json | null }>(`${API}/account/session`, context?.signal);
      return then(result, value => {
        known = !!value.session; if (!value.session) return null;
        const account = value.session.account;
        // Anything that changes what this session may see changes the key, and with it every cached answer.
        return { id: value.session.id, accountId: account.id, name: account.name, audience: "dashboard", expiresAt: value.session.expiresAt, visibilityKey: `${value.session.id}.${account.securityRevision}.${account.permissionRevision}` };
      });
    },
    async signOut(): Promise<Result<void>> {
      const result = await http.post<unknown>(`${API}/auth/signout`, {}, { idempotencyKey: crypto.randomUUID() });
      if (result.ok) { known = false; securityChanged(); }
      return then(result, () => undefined);
    },
    subscribe(listener: (change: Change) => void): Unsubscribe { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };

  // An enrollment is started in one command and confirmed in the next; the factor it names is kept between the two.
  let pendingFactor: string | undefined;
  const receipt = (value: Json, extra: Partial<CommandReceipt> = {}): CommandReceipt => ({ message: value?.receipt?.message ?? value?.message ?? "Saved.", ...extra });
  const identity: IdentityService = {
    async request(input: AuthRequest) {
      if (input.purpose === "github") return unsupported("GitHub sign-in");
      // The first call gives this browser the proof the emailed link is bound to, and the terms version in force.
      const bootstrap = await http.get<Json>(`${API}/auth/bootstrap`);
      if (!bootstrap.ok) return bootstrap;
      const signup = input.purpose === "signup";
      const result = await http.post<Json>(`${API}/auth/challenges`, { email: input.email, purpose: signup ? "registration" : input.purpose === "recovery" ? "recovery" : "login",
        ...(signup ? { name: input.name ?? "", termsAccepted: input.termsAccepted === true, termsVersion: bootstrap.value.termsVersion } : {}), ...(input.returnTo ? { returnTo: input.returnTo } : {}) }, { idempotencyKey: crypto.randomUUID() });
      return then(result, value => ({ message: typeof value.message === "string" ? value.message : "If this address can be used, an email with the next step will arrive shortly." }));
    },
    async complete(token: string, code?: string) {
      const result = await http.post<Json>(`${API}/auth/complete`, { token, ...(code ? { code } : {}) });
      if (result.ok) { known = true; securityChanged(); }
      return then(result, value => ({ returnTo: typeof value.returnTo === "string" ? value.returnTo : "/organizations" }));
    },
    async recover() { return unsupported("Recovery by code"); },
    async getAccount(context?: AccountContext) {
      const [profile, identities] = await Promise.all([http.get<Json>(`${API}/account/profile`, context?.signal), http.get<Json>(`${API}/account/identities`, context?.signal)]);
      if (!profile.ok) return profile; if (!identities.ok) return identities;
      const account = profile.value.account;
      const value: Account = { id: account.id, name: account.name, email: account.email, avatar: account.avatar, revision: account.revision, status: "active", termsVersion: account.termsVersion, verifiedAt: account.verifiedAt,
        ...(profile.value.pendingEmailChange ? { pendingEmail: profile.value.pendingEmailChange.email } : {}), methods: [...new Set((identities.value.items as Json[]).map(item => item.provider as "email" | "github"))], mfa: account.mfa,
        // The live API does not report these two.
        recoveryCodesRemaining: 0, notifications: false };
      return ok(value);
    },
    async listSessions(page?: PageRequest, context?: AccountContext) {
      const result = await http.get<Json>(`${API}/account/sessions${pageQuery(page)}`, context?.signal);
      return then(result, value => pageOf((value.items as Json[]).map((item): AccountSession => ({ id: item.id, accountId: "", name: item.deviceName, audience: "dashboard", expiresAt: item.expiresAt, visibilityKey: "", current: item.current, revoked: false,
        createdAt: item.createdAt, lastActivityAt: item.createdAt })), value.nextCursor));
    },
    async command(input: AccountCommand, options: CommandOptions) {
      const profile = (body: Json) => http.post<Json>(`${API}/account/profile`, body, options).then(result => then(result, value => receipt(value)));
      const security = (body: Json) => http.post<Json>(`${API}/account/security`, body, options);
      switch (input.kind) {
        case "profile": return profile({ kind: "update", name: input.name, avatar: input.avatar });
        case "email": return profile({ kind: "email-change", email: input.email });
        case "revoke-session": return then(await security({ kind: "session-revoke", sessionId: input.sessionId }), value => receipt(value));
        case "revoke-others": return then(await security({ kind: "sessions-revoke-others" }), value => receipt(value));
        case "mfa-start": {
          const result = await security({ kind: "mfa-start" });
          if (result.ok) pendingFactor = result.value.enrollment?.factorId;
          // The secret is shown once, by the page, and is not kept here.
          return then(result, value => receipt(value, value.enrollment ? { secretValue: value.enrollment.secret } : {}));
        }
        case "mfa-confirm": {
          if (!pendingFactor) return failure("conflict", "Start MFA enrollment first, then enter the code from your authenticator.");
          const result = await security({ kind: "mfa-confirm", factorId: pendingFactor, code: input.code });
          if (result.ok) pendingFactor = undefined;
          return then(result, value => receipt(value, value.recoveryCodes ? { recoveryCodes: value.recoveryCodes } : {}));
        }
        case "mfa-disable": case "recovery-reset":
          return then(await security({ kind: input.kind, code: input.code }), value => receipt(value, value.recoveryCodes ? { recoveryCodes: value.recoveryCodes } : {}));
        default: return unsupported("This account action");
      }
    },
    async listNotifications() { return unsupported("Notifications"); },
    async markRead() { return unsupported("Notifications"); },
  };

  const catalog: BrowserServices["catalog"] = {
    async listOrganizations(page?: PageRequest, context?: AccountContext) {
      const result = await http.get<Json>(`${API}/orgs${pageQuery(page)}`, context?.signal);
      return then(result, value => pageOf((value.items as Json[]).map((item): Organization => ({ id: item.id, name: item.name, revision: item.revision })), value.nextCursor, page));
    },
    async resolveScope(context: RequestContext) {
      const scope = context.scope;
      // The server decides what this account may do here. Names come from the same resources the access check covers.
      const [access, organization, projectDetails, environmentDetails] = await Promise.all([
        http.get<Json>(`${orgPath(scope)}/access${pageQuery(undefined, { projectId: scope.projectId, environmentId: scope.environmentId })}`, context.signal),
        http.get<Json>(orgPath(scope), context.signal),
        scope.projectId ? http.get<Json>(projectPath(scope), context.signal) : undefined,
        scope.environmentId ? http.get<Json>(environmentPath(scope), context.signal) : undefined,
      ]);
      for (const result of [access, organization, projectDetails, environmentDetails]) if (result && !result.ok) return result;
      const granted = new Set((access as { value: Json }).value.permissions as Permission[]);
      const permissions = Object.fromEntries(PERMISSIONS.map(permission => [permission, granted.has(permission) ? { allowed: true } : { allowed: false, reason: "Your role in this organization does not include this." }])) as Permissions;
      const org = (organization as { value: Json }).value.organization; const projectRow = (projectDetails as { value: Json } | undefined)?.value; const environmentRow = (environmentDetails as { value: Json } | undefined)?.value;
      const resolved: ResolvedScope = { organization: { id: org.id, name: org.name, revision: org.revision }, permissions,
        ...(projectRow ? { project: project(projectRow.project ?? projectRow) } : {}), ...(environmentRow ? { environment: environment(environmentRow.environment) } : {}),
        bindings: ((environmentRow?.bindings ?? []) as Json[]).map(binding => ({ id: binding.id, scope: binding.scope, owner: binding.owner, serviceResourceId: binding.remoteResourceId ?? "", state: binding.state === "ready" || binding.state === "paused" ? "ready" : binding.state })) };
      return ok(resolved);
    },
    async listProjects(context: RequestContext, page?: PageRequest) {
      const result = await http.get<Json>(`${orgPath(context.scope)}/projects${pageQuery(page)}`, context.signal);
      return then(result, value => pageOf((value.items as Json[]).map(project), value.nextCursor, page));
    },
    async listEnvironments(context: RequestContext, page?: PageRequest) {
      const result = await http.get<Json>(`${projectPath(context.scope)}/environments${pageQuery(page)}`, context.signal);
      return then(result, value => pageOf((value.items as Json[]).map(environment), value.nextCursor, page));
    },
  };

  const platform: PlatformService = {
    async command(context: RequestContext | undefined, input: PlatformCommand, options: CommandOptions) {
      if (input.kind === "organization-create") {
        // A new organization has no revision to match.
        const result = await http.post<Json>(`${API}/orgs`, { name: input.name, slug: input.namespace }, { idempotencyKey: options.idempotencyKey });
        return then(result, value => receipt(value, { resourceId: value.receipt.id }));
      }
      if (!context) return failure("validation", "This action needs an organization.");
      const scope = context.scope; const send = async (path: string, body: Json) => then(await http.post<Json>(path, body, options), value => receipt(value));
      switch (input.kind) {
        case "organization-update": return send(`${orgPath(scope)}/settings`, { kind: "update", name: input.name, slug: input.namespace });
        case "organization-policy": return send(`${orgPath(scope)}/settings`, { kind: "policy", requireMfa: input.requireMfa });
        case "member-update": return send(`${orgPath(scope)}/members`, { kind: "member-role", membershipId: input.memberId, role: input.role });
        case "member-remove": return send(`${orgPath(scope)}/members`, { kind: "member-revoke", membershipId: input.memberId });
        case "leave": return send(`${orgPath(scope)}/members`, { kind: "leave" });
        case "invite": return send(`${orgPath(scope)}/invitations`, { kind: "create", email: input.email, role: input.role });
        case "invite-resend": return send(`${orgPath(scope)}/invitations`, { kind: "resend", invitationId: input.invitationId });
        case "invite-cancel": return send(`${orgPath(scope)}/invitations`, { kind: "cancel", invitationId: input.invitationId });
        // What a project starts with is which owning services it is given.
        case "project-create": return send(`${orgPath(scope)}/projects`, { name: input.name, slug: input.slug, services: input.mode === "data" ? ["database"] : input.mode === "builds" ? ["registry"] : ["database", "registry"] });
        case "project-archive": return send(projectPath(scope), { kind: "archive", archived: input.archived, confirmation: input.confirmation });
        case "environment-create": return send(`${projectPath(scope)}/environments`, { name: input.name, kind: input.environment, services: ["database", "registry"] });
        case "environment-pause": return send(environmentPath(scope), { kind: "pause", paused: input.paused, ...(/^[a-z][a-z0-9-]{2,39}$/.test(input.confirmation) ? { productionConfirmation: input.confirmation } : {}) });
        default: return unsupported("This organization action");
      }
    },
    async getOrganization(context: RequestContext) {
      const result = await http.get<Json>(orgPath(context.scope), context.signal);
      return then(result, (value): OrganizationDetails => ({ namespace: value.organization.slug, billingContact: "", requireMfa: value.organization.requireMfa, revision: value.organization.revision,
        transfers: value.transfer ? [{ id: value.transfer.id, orgId: context.scope.orgId, from: value.transfer.fromAccountId, to: value.transfer.toAccountId, previousRole: value.transfer.previousRole, status: "pending", revision: value.organization.revision }] : [],
        serviceAccountPolicy: "" }));
    },
    async listMembers(context: RequestContext, page?: PageRequest) {
      const result = await http.get<Json>(`${orgPath(context.scope)}/members${pageQuery(page)}`, context.signal);
      return then(result, value => pageOf((value.items as Json[]).map((item): Member => ({ id: item.id, name: item.name, email: item.email, accountId: item.accountId, role: item.role, projects: [], grants: [], revision: item.revision })), value.nextCursor, page));
    },
    async listInvitations(context?: RequestContext, page?: PageRequest) {
      // The live API lists what an organization sent. It has no list of what an account received.
      if (!context) return ok({ items: [], nextCursor: null, total: 0 });
      const result = await http.get<Json>(`${orgPath(context.scope)}/invitations${pageQuery(page)}`, context.signal);
      return then(result, value => pageOf((value.items as Json[]).map((item): Invitation => ({ id: item.id, name: item.email, email: item.email, orgId: context.scope.orgId, role: item.role, projects: [],
        status: item.state === "superseded" ? "cancelled" : item.state, expiresAt: item.expiresAt, revision: item.revision } as Invitation)), value.nextCursor, page));
    },
    async previewInvitation(token: string) {
      const result = await http.post<Json>(`${API}/invitations/preview`, { token });
      return then(result, value => ({ organization: value.organizationName, role: value.role, status: "pending" as const, expiresAt: value.expiresAt }));
    },
    async respondInvitation(token: string, accept: boolean) {
      if (!accept) return unsupported("Declining an invitation");
      const result = await http.post<Json>(`${API}/invitations/accept`, { token }, { idempotencyKey: crypto.randomUUID() });
      if (result.ok) securityChanged();
      return then(result, value => ({ orgId: value.receipt.orgId as string }));
    },
  };

  const activity: BrowserServices["activity"] = {
    async listAudit(context: RequestContext, page?: AuditRequest) {
      const scope = context.scope;
      const result = await http.get<Json>(`${orgPath(scope)}/audit${pageQuery(page, { projectId: page?.projectId ?? scope.projectId, environmentId: page?.environmentId ?? scope.environmentId })}`, context.signal);
      // The log records what happened; a refused request is not an entry in it.
      return then(result, value => ({ nextCursor: value.nextCursor, total: value.items.length, items: (value.items as Json[]).map((item): Audit => ({ id: item.id, scope: item.scope, actorId: item.actor.id ?? item.actor.kind, action: item.action,
        resourceId: item.resource.id, outcome: "succeeded", occurredAt: item.occurredAt, requestId: item.requestId })) }));
    },
  };

  const capabilities: BrowserServices["capabilities"] = {
    async getAvailableCapabilities(): Promise<Result<readonly Capability[]>> {
      const later = "Not connected to the live service in this version of the frontend.";
      return ok([
        { id: "account", owner: "cloud", available: true }, { id: "organizations", owner: "cloud", available: true }, { id: "catalog", owner: "cloud", available: true }, { id: "activity", owner: "cloud", available: true },
        { id: "functions", owner: "cloud", available: true },
        ...["credentials", "builds", "releases", "billing"].map(id => ({ id, owner: "cloud" as const, available: false, reason: later })),
        ...["data", "storage", "app-auth", "vectors", "graph", "realtime"].map(id => ({ id, owner: "database" as const, available: false, reason: later })),
        { id: "registry", owner: "registry", available: false, reason: later },
      ]);
    },
  };

  // Functions. Each call is one request to the route of the same name; nothing is reshaped beyond dropping what the pages do not show.
  const fn = (row: Json): LiveFunction => ({ id: row.id, name: row.name, state: row.state, activeRevision: row.activeRevision, latestRevision: row.latestRevision, revision: row.revision, createdAt: row.createdAt });
  const execution = (row: Json): LiveExecution => ({ id: row.id, functionId: row.functionId, revisionNumber: row.revisionNumber, state: row.state, trigger: row.trigger, attempt: row.attempt, output: row.output ?? null,
    errorCategory: row.errorCategory ?? null, hasLogs: row.hasLogs === true, prunedAt: row.prunedAt ?? null, scheduleId: row.scheduleId ?? null, retryOf: row.retryOf ?? null, revision: row.revision,
    createdAt: row.createdAt, startedAt: row.startedAt ?? null, completedAt: row.completedAt ?? null });
  const schedule = (row: Json): LiveSchedule => ({ id: row.id, functionId: row.functionId, intervalSeconds: row.intervalSeconds ?? null, cron: row.cron ?? null, timeZone: row.timeZone ?? null, input: row.input ?? null, state: row.state,
    nextRunAt: row.nextRunAt, lastRunAt: row.lastRunAt ?? null, lastSkippedAt: row.lastSkippedAt ?? null, lastSkipReason: row.lastSkipReason ?? null, revision: row.revision });
  const liveFunctions: LiveFunctionService = {
    async list(context, page) {
      const result = await http.get<Json>(`${environmentPath(context.scope)}/functions${pageQuery(page)}`, context.signal);
      return then(result, value => ({ items: (value.items as Json[]).map(fn), nextCursor: value.nextCursor as string | null, total: (value.items as Json[]).length }));
    },
    async get(context, id) {
      const result = await http.get<Json>(`${environmentPath(context.scope)}/functions/${id}`, context.signal);
      return then(result, (value): LiveFunctionDetails => ({ function: fn(value.function), revisions: (value.revisions as Json[]).map(row => ({ number: row.number, codeDigest: row.codeDigest, secretNames: row.secretNames, timeoutSeconds: row.timeoutSeconds, createdAt: row.createdAt })) }));
    },
    async code(context, id, revision) {
      const result = await http.get<Json>(`${environmentPath(context.scope)}/functions/${id}/revisions/${revision}`, context.signal);
      return then(result, value => value.code as string);
    },
    async deploy(context, input, options) {
      const result = await http.post<Json>(`${environmentPath(context.scope)}/functions`, { name: input.name, code: input.code, secretNames: [...input.secretNames], timeoutSeconds: input.timeoutSeconds }, { idempotencyKey: options.idempotencyKey });
      return then(result, (value): CommandReceipt => ({ message: value.message, resourceId: value.function.id }));
    },
    async command(context, id, command, options) {
      const result = await http.post<Json>(`${environmentPath(context.scope)}/functions/${id}`, command, options);
      return then(result, (value): CommandReceipt => ({ message: value.message, resourceId: value.function.id }));
    },
    async invoke(context, id, input, options) {
      const result = await http.post<Json>(`${environmentPath(context.scope)}/functions/${id}/invoke`, { input: input ?? null }, { idempotencyKey: options.idempotencyKey });
      return then(result, (value): CommandReceipt => ({ message: value.message, resourceId: value.execution.id }));
    },
    async executions(context, id, page) {
      const result = await http.get<Json>(`${environmentPath(context.scope)}/functions/${id}/executions${pageQuery(page)}`, context.signal);
      return then(result, value => ({ items: (value.items as Json[]).map(execution), nextCursor: value.nextCursor as string | null, total: (value.items as Json[]).length }));
    },
    async execution(context, executionId) {
      return then(await http.get<Json>(`${environmentPath(context.scope)}/executions/${executionId}`, context.signal), execution);
    },
    async logs(context, executionId) {
      const result = await http.get<Json>(`${environmentPath(context.scope)}/executions/${executionId}/logs`, context.signal);
      // No log is an answer, not a failure: the execution printed nothing, or its contents were removed.
      if (!result.ok) return result.error.code === "not_found" ? ok(null) : result;
      return ok<LiveExecutionLogs>({ text: result.value.text, truncated: result.value.truncated === true, attempt: result.value.attempt, recordedAt: result.value.recordedAt });
    },
    async executionCommand(context, executionId, kind, options) {
      const result = await http.post<Json>(`${environmentPath(context.scope)}/executions/${executionId}`, { kind }, options);
      return then(result, (value): CommandReceipt => ({ message: value.message, resourceId: value.execution.id }));
    },
    async schedules(context, id) {
      return then(await http.get<Json>(`${environmentPath(context.scope)}/functions/${id}/schedules`, context.signal), value => (value.items as Json[]).map(schedule));
    },
    async createSchedule(context, id, input, options) {
      const result = await http.post<Json>(`${environmentPath(context.scope)}/functions/${id}/schedules`, input, { idempotencyKey: options.idempotencyKey });
      return then(result, (value): CommandReceipt => ({ message: value.message, resourceId: value.schedule.id }));
    },
    async scheduleCommand(context, scheduleId, kind, options) {
      const result = await http.post<Json>(`${environmentPath(context.scope)}/schedules/${scheduleId}`, { kind }, options);
      return then(result, (value): CommandReceipt => ({ message: value.message, resourceId: value.schedule.id }));
    },
  };

  const services: BrowserServices = {
    session, identity, platform, catalog, activity, capabilities, liveFunctions,
    configuration: notConnected("Credentials and configuration"), delivery: notConnected("Builds and releases"), data: notConnected("Database"), appAuth: notConnected("Application authentication"),
    extensions: notConnected("Storage, vectors, graph and realtime"), functions: notConnected("Functions"), registry: notConnected("Registry"), billing: notConnected("Billing"), operator: notConnected("Operator tools"),
    operations: notConnected("Operations"), events: notConnected("Live events"),
  };
  return { services, transport: http };
}
