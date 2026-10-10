import type { CommandReceipt, PlatformService } from "../../../presentation/framework/services/identity-contracts";
import type { Operation, Role, Scope } from "../../../presentation/framework/services/contracts";
import { Refusal, requirePermission, requireSession, resolveScope } from "./access";
import { now } from "./clock";
import { allocate, bump, identityState } from "./identity-state";
import { accountFor, emailAddress, fresh, notifyAccount, once, requiredName, revision, type Run } from "./identity-services";
import { paginate } from "./pagination";
import type { Membership, MockState } from "./store";

function namespace(value: string) {
  if (!/^[a-z][a-z0-9-]{2,39}$/.test(value)) throw new Refusal("validation", "Use 3–40 lowercase letters, digits or hyphens, starting with a letter.");
  return value;
}
const membership = (state: MockState, orgId: string, accountId: string) => Object.values(state.memberships).find(m => m.active && m.orgId === orgId && m.accountId === accountId);
function memberById(state: MockState, scope: Scope, id: string): Membership {
  const member = state.memberships[id];
  if (!member?.active || member.orgId !== scope.orgId) throw new Refusal("not_found", "Member not found.");
  return member;
}
function protectOwner(state: MockState, member: Membership) {
  if (member.role === "Owner") throw new Refusal("conflict", "Use accepted ownership transfer to change an owner. The last owner cannot be removed.");
}
function assignments(state: MockState, scope: Scope, projects: string[], role: Role) {
  if (!["Admin", "Developer", "Viewer", "Billing"].includes(role)) throw new Refusal("validation", "Choose a non-owner role.");
  if (role === "Billing" && projects.length) throw new Refusal("validation", "Billing members cannot receive project assignments.");
  for (const id of projects) if (state.projects[id]?.orgId !== scope.orgId) throw new Refusal("not_found", "Assigned project not found.");
}
export function platformAudit(state: MockState, scope: Scope, actorId: string, action: string, resourceId: string, requestId: string, time: number) {
  const id = allocate(state, "audit"), occurredAt = new Date(time).toISOString();
  state.audits[id] = { id, scope, actorId, action, resourceId, outcome: "succeeded", requestId, occurredAt };
  const cursor = String(++state.sequence);
  state.events[`event_${cursor}`] = { id: `event_${cursor}`, cursor, scope, actorId, action, resourceId, revision: "r1", occurredAt };
}
function provision(state: MockState, scope: Scope, services: string[], actorId: string, requestId: string, time: number): Operation {
  if (Object.values(state.operations).some(o => o.record.kind === "environment.provision" && o.record.scope.environmentId === scope.environmentId && !["succeeded", "failed", "cancelled"].includes(o.record.state))) throw new Refusal("conflict", "Provisioning is already running. Open its progress before starting another request.");
  const id = allocate(state, "operation"), steps = [...new Set(["cloud", ...services])];
  for (const owner of steps) {
    if (!["cloud", "database", "auth", "functions"].includes(owner)) throw new Refusal("validation", "Unsupported provisioning service.");
    const bindingId = `${scope.environmentId}:${owner}`;
    if (!Object.values(state.bindings).some(b => b.scope.environmentId === scope.environmentId && b.owner === owner && b.state === "ready")) state.bindings[bindingId] = { id: bindingId, scope, owner: owner as "cloud", serviceResourceId: `mock-${bindingId}`, state: "pending" };
  }
  const operation: Operation = { id, kind: "environment.provision", scope, actorId, state: "queued", completedSteps: 0, totalSteps: steps.length, steps, revision: "r1", createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), requestId, actions: { cancel: { allowed: true }, retry: { allowed: false, reason: "Only failed provisioning can be retried." } } };
  const data = identityState(state);
  state.operations[id] = { record: operation, deadline: time + 1000, failStep: data.nextProvisionFailure ? Math.min(1, steps.length - 1) : null };
  data.nextProvisionFailure = false;
  Object.assign(state.environments[scope.environmentId!], { status: "provisioning" });
  return operation;
}
export function reconcileProvisioning(state: MockState, operation: Operation) {
  if (operation.kind !== "environment.provision") return;
  const environment = state.environments[operation.scope.environmentId!], project = state.projects[operation.scope.projectId!];
  if (!environment || !project) return;
  for (const binding of Object.values(state.bindings).filter(b => b.scope.environmentId === environment.id)) {
    const index = operation.steps.indexOf(binding.owner);
    if (index < 0) continue;
    if (index < operation.completedSteps) Object.assign(binding, { state: "ready" });
    else if (["failed", "cancelled"].includes(operation.state) && binding.state !== "ready") Object.assign(binding, { state: "failed" });
  }
  Object.assign(environment, { status: operation.state === "succeeded" ? "ready" : ["failed", "cancelled"].includes(operation.state) ? "degraded" : "provisioning", revision: bump(environment.revision) });
  const siblings = Object.values(state.environments).filter(e => e.projectId === project.id);
  Object.assign(project, { status: siblings.some(e => e.status === "degraded") ? "degraded" : siblings.some(e => e.status === "provisioning") ? "provisioning" : "ready", revision: bump(project.revision) });
}
export function createPlatformServices(run: Run, wallTime: () => number): PlatformService {
  return {
    command: (context, input, options) => run((state, requestId) => {
      const account = accountFor(state, wallTime()), data = identityState(state), time = now(state.clock, wallTime());
      let scope = context?.scope;
      const actor = scope ? membership(state, scope.orgId, account.id) : undefined;
      if (input.kind !== "organization-create") {
        if (!scope) throw new Refusal("validation", "Organization scope required.");
        resolveScope(state, scope, wallTime());
        const permission = input.kind === "billing-contact" ? "billing.manage" : input.kind === "project-create" ? "projects.create" : ["environment-create", "environment-configure", "provision"].includes(input.kind) ? "resources.configure" : ["leave", "transfer-accept"].includes(input.kind) ? undefined : ["organization-update", "organization-policy", "environment-pause", "project-archive"].includes(input.kind) ? "organization.manage" : "members.manage";
        if (permission) requirePermission(state, scope, permission, wallTime());
      }
      return once(state, account.id, scope, input, options, (): CommandReceipt => {
        let resourceId = scope?.environmentId ?? scope?.projectId ?? scope?.orgId ?? account.id;
        let operation: Operation | undefined;
        const org = scope ? state.organizations[scope.orgId] : undefined;
        if (org && !["member-update", "member-remove", "invite-resend", "invite-cancel", "transfer-accept", "environment-configure", "environment-pause", "project-archive"].includes(input.kind)) revision(org.revision, options);
        switch (input.kind) {
          case "organization-create": {
            const name = requiredName(input.name), ns = namespace(input.namespace);
            if (Object.values(data.organizations).some(o => o.namespace === ns)) throw new Refusal("conflict", "Organization namespace is already taken.");
            const id = allocate(state, "org"), memberId = allocate(state, "member");
            state.organizations[id] = { id, name, revision: "r1" };
            data.organizations[id] = { namespace: ns, billingContact: account.email, requireMfa: false, entitlement: "free" };
            state.memberships[memberId] = { id: memberId, orgId: id, accountId: account.id, role: "Owner", projects: [], grants: [], active: true, revision: "r1" };
            scope = { orgId: id }; resourceId = id; state.accessRevision++; break;
          }
          case "organization-update": {
            const ns = namespace(input.namespace);
            if (Object.entries(data.organizations).some(([id, o]) => id !== scope!.orgId && o.namespace === ns)) throw new Refusal("conflict", "Organization namespace is already taken.");
            Object.assign(org!, { name: requiredName(input.name) }); data.organizations[scope!.orgId].namespace = ns; break;
          }
          case "billing-contact": data.organizations[scope!.orgId].billingContact = emailAddress(input.email); break;
          case "organization-policy":
            fresh(state, wallTime());
            if (input.requireMfa && (!account.mfa || !data.sessionDetails[requireSession(state, wallTime()).id]?.mfa)) throw new Refusal("forbidden", "Enroll MFA and verify your session before requiring MFA for the organization.");
            data.organizations[scope!.orgId].requireMfa = input.requireMfa; state.accessRevision++; break;
          case "invite": {
            const email = emailAddress(input.email); assignments(state, scope!, input.projects, input.role);
            if (Object.values(state.memberships).some(m => m.active && m.orgId === scope!.orgId && data.accounts[m.accountId]?.email === email)) throw new Refusal("conflict", "This account is already a member.");
            if (Object.values(data.invitations).some(i => i.orgId === scope!.orgId && i.email === email && i.status === "pending")) throw new Refusal("conflict", "A pending invitation exists. Resend or cancel it.");
            const id = allocate(state, "invite"), token = crypto.randomUUID();
            data.invitations[id] = { id, token, name: email, email, orgId: scope!.orgId, role: input.role, projects: [...new Set(input.projects)], status: "pending", expiresAt: new Date(time + 604_800_000).toISOString(), revision: "r1" };
            resourceId = id;
            const recipient = Object.values(data.accounts).find(a => a.email === email && a.status === "active");
            if (recipient) notifyAccount(state, recipient.id, `Invitation to ${org!.name}`, `/invites/${token}`, time);
            break;
          }
          case "invite-resend": case "invite-cancel": {
            const invite = data.invitations[input.invitationId];
            if (!invite || invite.orgId !== scope!.orgId) throw new Refusal("not_found", "Invitation not found.");
            revision(invite.revision, options);
            if (!["pending", "expired"].includes(invite.status)) throw new Refusal("conflict", "Invitation has already been resolved.");
            data.invitations[invite.id] = { ...invite, token: crypto.randomUUID(), status: input.kind === "invite-cancel" ? "cancelled" : "pending", expiresAt: new Date(time + 604_800_000).toISOString(), revision: bump(invite.revision) }; resourceId = invite.id; break;
          }
          case "member-update": {
            const target = memberById(state, scope!, input.memberId); revision(target.revision ?? "r1", options); protectOwner(state, target);
            assignments(state, scope!, input.projects, input.role);
            for (const grant of input.grants) {
              if (grant.scope.orgId !== scope!.orgId || (input.role !== "Admin" && grant.scope.projectId && !input.projects.includes(grant.scope.projectId))) throw new Refusal("validation", "Grants must stay within assigned projects and this organization.");
              const allowed = input.role === "Developer" ? ["projects.create", "resources.configure", "data.read", "data.write", "release.publish", "audit.read", "build.cancel.any"] : input.role === "Viewer" ? ["data.read"] : input.role === "Admin" ? ["signing.manage"] : [];
              if (!allowed.includes(grant.permission)) throw new Refusal("forbidden", "This role cannot receive that capability.");
              requirePermission(state, grant.scope, grant.permission, wallTime());
            }
            Object.assign(target, { role: input.role, projects: [...new Set(input.projects)], grants: input.grants, revision: bump(target.revision ?? "r1") }); resourceId = target.id; state.accessRevision++; break;
          }
          case "member-remove": case "leave": {
            const target = input.kind === "leave" ? actor! : memberById(state, scope!, input.memberId);
            if (input.kind === "member-remove") revision(target.revision ?? "r1", options);
            protectOwner(state, target); target.active = false; target.grants = []; target.projects = []; target.revision = bump(target.revision ?? "r1");
            for (const transfer of Object.values(data.transfers)) if (transfer.orgId === scope!.orgId && transfer.to === target.accountId && transfer.status === "pending") Object.assign(transfer, { status: "cancelled", revision: bump(transfer.revision) });
            resourceId = target.id; state.accessRevision++; break;
          }
          case "transfer": {
            if (actor?.role !== "Owner") throw new Refusal("forbidden", "Only an owner can transfer ownership.");
            fresh(state, wallTime()); const target = memberById(state, scope!, input.memberId);
            if (target.accountId === account.id || target.role === "Owner") throw new Refusal("validation", "Select another active non-owner member.");
            if (!["Admin", "Developer", "Viewer", "Billing"].includes(input.previousRole)) throw new Refusal("validation", "Choose the prior owner's lesser role.");
            for (const t of Object.values(data.transfers)) if (t.orgId === scope!.orgId && t.status === "pending") Object.assign(t, { status: "cancelled" });
            const id = allocate(state, "transfer"); data.transfers[id] = { id, orgId: scope!.orgId, from: account.id, to: target.accountId, previousRole: input.previousRole, status: "pending", revision: "r1" };
            notifyAccount(state, target.accountId, "Ownership transfer requires your acceptance", `/orgs/${scope!.orgId}/settings`, time); resourceId = id; break;
          }
          case "transfer-accept": {
            fresh(state, wallTime()); const transfer = data.transfers[input.transferId];
            if (!transfer || transfer.orgId !== scope!.orgId || transfer.to !== account.id) throw new Refusal("not_found", "Transfer not found.");
            revision(transfer.revision, options);
            const from = membership(state, scope!.orgId, transfer.from);
            if (transfer.status !== "pending" || from?.role !== "Owner") throw new Refusal("conflict", "Transfer is no longer pending.");
            Object.assign(actor!, { role: "Owner", grants: [], revision: bump(actor!.revision ?? "r1") }); Object.assign(from, { role: transfer.previousRole, grants: [], projects: [], revision: bump(from.revision ?? "r1") });
            Object.assign(transfer, { status: "accepted", revision: bump(transfer.revision) }); resourceId = transfer.id; state.accessRevision++; break;
          }
          case "project-create": {
            const name = requiredName(input.name), slug = namespace(input.slug);
            if (!["data", "builds", "both"].includes(input.mode)) throw new Refusal("validation", "Choose data, builds or both.");
            if (Object.values(state.projects).some(p => p.orgId === scope!.orgId && p.slug === slug)) throw new Refusal("conflict", "Project slug is already taken in this organization.");
            if (!["development", "staging", "production"].includes(input.environment)) throw new Refusal("validation", "Choose a supported environment.");
            if (input.environment === "production" && actor?.role !== "Owner" && actor?.role !== "Admin") throw new Refusal("forbidden", "Create development first; production requires a scoped grant.");
            const projectId = allocate(state, "project"), environmentId = allocate(state, "environment");
            state.projects[projectId] = { id: projectId, orgId: scope!.orgId, name, slug, mode: input.mode, status: "provisioning", revision: "r1" };
            state.environments[environmentId] = { id: environmentId, projectId, name: input.environment, kind: input.environment, status: "provisioning", revision: "r1", requireProductionConfirmation: true };
            if (actor?.role === "Developer") actor.projects.push(projectId);
            const target = { orgId: scope!.orgId, projectId, environmentId };
            operation = provision(state, target, input.mode === "builds" ? [] : ["database", "auth", "functions"], account.id, requestId, time); resourceId = projectId; break;
          }
          case "project-archive": {
            const project = state.projects[scope!.projectId ?? ""];
            if (!project || scope!.environmentId) throw new Refusal("validation", "Project lifecycle changes require project scope.");
            revision(project.revision, options);
            if (input.confirmation !== project.name) throw new Refusal("validation", "Type the exact project name to confirm the lifecycle change.");
            if (input.archived && Object.values(state.operations).some(item => item.record.scope.projectId === project.id && ["queued", "running", "cancel_requested"].includes(item.record.state))) throw new Refusal("conflict", "Finish or cancel active operations before archiving this project.");
            state.projects[project.id] = { ...project, status: input.archived ? "archived" : Object.values(state.environments).some(env => env.projectId === project.id && env.status === "degraded") ? "degraded" : "ready", revision: bump(project.revision) };
            resourceId = project.id; state.accessRevision++; break;
          }
          case "environment-create": {
            if (!scope!.projectId || scope!.environmentId) throw new Refusal("validation", "Select a project to create an environment.");
            if (!["development", "staging", "production"].includes(input.environment)) throw new Refusal("validation", "Choose a supported environment.");
            const name = requiredName(input.name);
            if (Object.values(state.environments).some(e => e.projectId === scope!.projectId && e.name.toLowerCase() === name.toLowerCase())) throw new Refusal("conflict", "Environment name is already used.");
            if (input.environment === "production" && actor?.role !== "Owner" && actor?.role !== "Admin") throw new Refusal("forbidden", "Only Owner/Admin can create a production environment; delegate actions afterward.");
            const id = allocate(state, "environment"); state.environments[id] = { id, projectId: scope!.projectId, name, kind: input.environment, status: "provisioning", revision: "r1", requireProductionConfirmation: true };
            operation = provision(state, { ...scope!, environmentId: id }, state.projects[scope!.projectId].mode === "builds" ? [] : ["database", "auth", "functions"], account.id, requestId, time); resourceId = id; break;
          }
          case "environment-configure": case "environment-pause": {
            const env = state.environments[scope!.environmentId ?? ""];
            if (!env) throw new Refusal("validation", "Select an environment."); revision(env.revision, options);
            if (input.kind === "environment-configure") {
              const name = requiredName(input.name);
              if (Object.values(state.environments).some(e => e.id !== env.id && e.projectId === env.projectId && e.name.toLowerCase() === name.toLowerCase())) throw new Refusal("conflict", "Environment name is already used.");
              if (actor?.role !== "Owner" && actor?.role !== "Admin") throw new Refusal("forbidden", "Only administrators can change environment policy.");
              Object.assign(env, { name, requireProductionConfirmation: input.requireProductionConfirmation });
            } else {
              if (input.confirmation !== env.name) throw new Refusal("validation", "Type the exact environment name to confirm pause/resume.");
              if (Object.values(state.operations).some(o => o.record.scope.environmentId === env.id && ["queued", "running", "cancel_requested"].includes(o.record.state))) throw new Refusal("conflict", "Finish or cancel active operations before pausing.");
              Object.assign(env, { status: input.paused ? "paused" : Object.values(state.bindings).some(b => b.scope.environmentId === env.id && b.state !== "ready") ? "degraded" : "ready" }); state.accessRevision++;
            }
            Object.assign(env, { revision: bump(env.revision) }); break;
          }
          case "provision": {
            const env = state.environments[scope!.environmentId ?? ""];
            if (!env) throw new Refusal("validation", "Select an environment.");
            if (env.kind === "production" && env.requireProductionConfirmation !== false && input.confirmation !== env.name) throw new Refusal("validation", "Type the production environment name before enabling resources.");
            operation = provision(state, scope!, input.services, account.id, requestId, time); resourceId = env.id; break;
          }
        }
        if (org) Object.assign(org, { revision: bump(org.revision) });
        platformAudit(state, scope!, account.id, input.kind, resourceId, requestId, time);
        return { message: operation ? "Provisioning queued. Progress is saved and resumes after reload." : "Change saved.", resourceId, operation };
      });
    }, { mutate: true, signal: context?.signal, ...(context ? { audit: { scope: context.scope, action: `${input.kind}.refused` } } : {}) }),
    getOrganization: context => run(state => {
      const resolved = resolveScope(state, context.scope, wallTime()), data = identityState(state), account = accountFor(state, wallTime());
      return { ...data.organizations[context.scope.orgId], revision: resolved.organization.revision, transfers: Object.values(data.transfers).filter(t => t.orgId === context.scope.orgId && (t.to === account.id || t.from === account.id)), serviceAccountPolicy: "Member removal clears personal scoped grants. Organization-owned service accounts remain organization-owned; credential inventory arrives in Slice 3." };
    }, { signal: context.signal }),
    listMembers: (context, page) => run(state => {
      resolveScope(state, context.scope, wallTime());
      const data = identityState(state), account = accountFor(state, wallTime());
      const elevated = ["Owner", "Admin"].includes(membership(state, context.scope.orgId, account.id)!.role);
      const members = Object.values(state.memberships).filter(m => m.active && m.orgId === context.scope.orgId && (elevated || m.accountId === account.id)).map(m => ({ ...m, revision: m.revision ?? "r1", name: data.accounts[m.accountId].name, email: data.accounts[m.accountId].email }));
      return paginate(members, page, `${requireSession(state, wallTime()).visibilityKey}:${context.scope.orgId}:members`);
    }, { signal: context.signal }),
    listInvitations: (context, page) => run(state => {
      const account = accountFor(state, wallTime());
      if (context) requirePermission(state, context.scope, "members.manage", wallTime());
      return paginate(Object.values(identityState(state).invitations).filter(i => context ? i.orgId === context.scope.orgId : i.email === account.email).map(({ token, ...dto }) => ({ ...dto, ...(!context ? { href: `/invites/${token}` } : {}) })), page, `${requireSession(state, wallTime()).visibilityKey}:${context?.scope.orgId ?? "self"}:invites`);
    }, { signal: context?.signal }),
    previewInvitation: token => run(state => {
      const invite = Object.values(identityState(state).invitations).find(i => i.token === token);
      if (!invite) throw new Refusal("not_found", "Invitation not found. It may have been replaced by a resend.");
      return { organization: state.organizations[invite.orgId].name, role: invite.role, status: invite.status, expiresAt: invite.expiresAt };
    }),
    respondInvitation: (token, accept) => run((state, requestId) => {
      const account = accountFor(state, wallTime()), data = identityState(state), time = now(state.clock, wallTime());
      const invite = Object.values(data.invitations).find(i => i.token === token);
      if (!invite) throw new Refusal("not_found", "Invitation not found.");
      if (account.email !== invite.email || !account.verifiedAt) throw new Refusal("forbidden", "Sign in with the matching verified email to respond to this invitation.");
      if (invite.status !== "pending") throw new Refusal("conflict", `Invitation is ${invite.status}. Request a new invitation if needed.`);
      if (membership(state, invite.orgId, account.id)) throw new Refusal("conflict", "Already a member of this organization.");
      if (accept) {
        assignments(state, { orgId: invite.orgId }, [...invite.projects], invite.role);
        const id = allocate(state, "member"); state.memberships[id] = { id, orgId: invite.orgId, accountId: account.id, role: invite.role, projects: [...invite.projects], grants: [], active: true, revision: "r1" };
        notifyAccount(state, account.id, `Joined ${state.organizations[invite.orgId].name}`, `/orgs/${invite.orgId}/overview`, time);
      }
      Object.assign(invite, { status: accept ? "accepted" : "declined", revision: bump(invite.revision) }); state.accessRevision++;
      platformAudit(state, { orgId: invite.orgId }, account.id, accept ? "invitation.accepted" : "invitation.declined", invite.id, requestId, time);
      return { orgId: invite.orgId };
    }, { mutate: true }),
  };
}


