import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { scopeKey } from "../../framework/queries/scope-cache";
import { scopePath } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import { unwrap, type Permission, type ResolvedScope, type Role, type Scope } from "../../framework/services/contracts";
import type { Member } from "../../framework/services/identity-contracts";
import { useSession } from "../../framework/session/SessionProvider";
import { CommandForm, choices } from "./Forms";
import { Pager } from "./IdentityPages";
import { CatalogPage } from "../foundation/CatalogPage";


const roles = ["Admin", "Developer", "Viewer", "Billing"] as const;
const environments = choices(["development", "staging", "production"]);
export function CreateResource({ scope, resolved }: { scope?: Scope; resolved?: ResolvedScope }) {
  const services = useServices(), navigate = useNavigate();
  const environment = !!scope?.projectId, organization = !scope;
  const permission = organization ? undefined : resolved?.permissions[environment ? "resources.configure" : "projects.create"];
  return <CommandForm title={organization ? "Create organization" : environment ? "Create environment" : "Create project"} revision={resolved?.organization.revision} disabled={permission && !permission.allowed ? permission.reason : undefined} fields={[
    { name: "name", label: "Name" },
    ...(!environment ? [{ name: "slug", label: organization ? "Organization namespace" : "Project slug" }] : []),
    ...(!organization ? [{ name: "environment", label: environment ? "Environment kind" : "Initial environment", value: "development", options: environments }] : []),
    ...(!organization && !environment ? [{ name: "mode", label: "Start with", value: "data", options: choices(["data", "builds", "both"]) }] : []),
  ]} submit={(v, o) => services.platform.command(scope ? { scope } : undefined, organization ? { kind: "organization-create", name: v.name, namespace: v.slug } : environment ? { kind: "environment-create", name: v.name, environment: v.environment as "development" } : { kind: "project-create", name: v.name, slug: v.slug, mode: v.mode as "data", environment: v.environment as "development" }, o)} after={result => {
    if (result.operation) navigate(`${scopePath(result.operation.scope)}/overview?operation=${result.operation.id}`);
    else if (result.resourceId) navigate(`/orgs/${result.resourceId}/overview`);
  }}><p>{organization ? "An available namespace creates an organization with you as Owner and the mock Free entitlement. Commercial settings arrive in Slice 9." : "Provisioning is local and staged. Each environment has isolated bindings. No customer data, secrets or repository settings are copied. Connect a repository from the project's setup checklist after creation."}</p></CommandForm>;
}
export function ScopeNavigation({ scope, resolved }: { scope: Scope; resolved: ResolvedScope }) {
  const org = scopePath({ orgId: scope.orgId }), project = scope.projectId ? scopePath({ orgId: scope.orgId, projectId: scope.projectId }) : undefined;
  return <nav aria-label="Platform scope navigation"><Link to="/organizations">Switch organization</Link><Link to={`${org}/projects`}>Projects</Link><Link to={`${org}/members`}>Members</Link><Link to={`${org}/settings`}>Organization settings</Link><Link to={`${org}/security`}>Organization security</Link><Link to={`${org}/connections`}>Repository connections</Link><Link to={`${org}/credentials`}>Credentials</Link><Link to={`${org}/activity`}>Activity</Link><Link to={`${org}/workers`}>Windows workers</Link>{project && <><Link to={`${project}/overview`}>Project overview</Link><Link to={`${project}/settings/general`}>General</Link><Link to={`${project}/settings/access`}>Project access</Link><Link to={`${project}/settings/environments`}>Environments</Link><Link to={`${project}/settings/repository`}>Repository</Link><Link to={`${project}/activity`}>Project activity</Link><Link to={`${project}/settings/build`}>Build settings</Link><Link to={`${project}/settings/signing`}>Signing</Link><Link to={`${project}/builds`}>Builds</Link><Link to={`${project}/releases`}>Releases</Link><Link to={`${project}/channels`}>Channels</Link></>}{resolved.environment && <><Link to={`${scopePath(scope)}/database/tables`}>Tables</Link><Link to={`${scopePath(scope)}/database/sql`}>SQL</Link><Link to={`${scopePath(scope)}/storage`}>Storage</Link><Link to={`${scopePath(scope)}/database/vectors`}>Vectors</Link><Link to={`${scopePath(scope)}/database/graph`}>Graph</Link><Link to={`${scopePath(scope)}/realtime`}>Realtime</Link><Link to={`${scopePath(scope)}/database/migrations`}>Migrations</Link><Link to={`${scopePath(scope)}/database/backups`}>Backups</Link><Link to={`${scopePath(scope)}/auth/users`}>App users</Link><Link to={`${scopePath(scope)}/auth/providers`}>Providers</Link><Link to={`${scopePath(scope)}/auth/settings`}>Auth settings</Link><Link to={`${scopePath(scope)}/auth/events`}>Auth events</Link><Link to={`${scopePath(scope)}/functions`}>Functions</Link><Link to={`${scopePath(scope)}/settings/api`}>API</Link><Link to={`${scopePath(scope)}/settings/secrets`}>Secrets</Link><span>{resolved.environment.kind}: {resolved.environment.name} · {resolved.environment.status}</span></>}</nav>;
}
export function PlatformPage({ scope, resolved }: { scope: Scope; resolved: ResolvedScope }) {
  const location = useLocation();
  if (location.pathname.endsWith("/members") || location.pathname.endsWith("/settings/access")) return <MembersPage scope={scope} resolved={resolved} />;
  if (location.pathname.endsWith("/settings/environments")) return <><CreateResource scope={scope} resolved={resolved} /><CatalogPage scope={scope} /></>;
  return <OrganizationSettings scope={scope} resolved={resolved} security={location.pathname.endsWith("/security")} />;
}
function OrganizationSettings({ scope, resolved, security }: { scope: Scope; resolved: ResolvedScope; security: boolean }) {
  const services = useServices(), { session } = useSession(), navigate = useNavigate();
  const query = useQuery({ queryKey: [...scopeKey(session!.visibilityKey, scope), "organization-details"], queryFn: async ({ signal }) => unwrap(await services.platform.getOrganization({ scope, signal })) });
  const canManage = resolved.permissions["organization.manage"].allowed;
  if (query.isPending) return <p>Loading organization settings…</p>;
  if (query.error) return <Feedback error={query.error} retry={() => void query.refetch()} />;
  const org = query.data, denied = canManage ? undefined : "Owner or Admin permission required.";
  return <section><p>Namespace: {org.namespace} · Revision {org.revision}</p><p>{org.serviceAccountPolicy}</p>
    {security ? <><CommandForm title="Save organization MFA policy" revision={org.revision} disabled={denied} fields={[{ name: "required", label: "Require MFA for organization access", value: String(org.requireMfa), options: choices(["true", "false"]) }]} submit={(v, o) => services.platform.command({ scope }, { kind: "organization-policy", requireMfa: v.required === "true" }, o)}><p>Members without an MFA-verified session will lose organization access immediately and can enroll from Account security.</p></CommandForm><p><Link to={`${scopePath({ orgId: scope.orgId })}/credentials`}>Review service accounts and organization credentials</Link>.</p></> : <>
      <CommandForm title="Save organization" revision={org.revision} disabled={denied} fields={[{ name: "name", label: "Organization name", value: resolved.organization.name }, { name: "namespace", label: "Namespace", value: org.namespace }]} submit={(v, o) => services.platform.command({ scope }, { kind: "organization-update", name: v.name, namespace: v.namespace }, o)} />
      <CommandForm title="Save billing contact" revision={org.revision} disabled={resolved.permissions["billing.manage"].allowed ? undefined : "Owner or Billing membership required."} fields={[{ name: "email", label: "Billing contact email (separate from account email)", value: org.billingContact, type: "email" }]} submit={(v, o) => services.platform.command({ scope }, { kind: "billing-contact", email: v.email }, o)} />
      <CommandForm title="Leave organization" revision={org.revision} fields={[{ name: "confirm", label: `Type ${resolved.organization.name} to leave` }]} submit={(v, o) => v.confirm !== resolved.organization.name ? Promise.resolve({ ok: false, error: { code: "validation", message: "Organization name did not match.", requestId: "form" } }) : services.platform.command({ scope }, { kind: "leave" }, o)} after={() => navigate("/organizations")}><p>Personal org grants are removed immediately. Owners must transfer ownership first.</p></CommandForm>
      <h2>Ownership transfer</h2><p>Select a recipient on Members, authenticate freshly, then ask the recipient to accept here. Prior ownership remains until acceptance.</p>
      {org.transfers.length === 0 && <p>No ownership transfers.</p>}{org.transfers.map(t => <article key={t.id}><p>{t.from} → {t.to} · {t.status} · Prior owner becomes {t.previousRole}</p>{t.to === session!.accountId && t.status === "pending" && <CommandForm title="Accept ownership" revision={t.revision} submit={(_, o) => services.platform.command({ scope }, { kind: "transfer-accept", transferId: t.id }, o)} />}</article>)}
      <p><Link to={`${scopePath({ orgId: scope.orgId })}/billing`}>Review deletion dependencies and retention, or schedule the recovery window in Billing.</Link></p>
    </>}
  </section>;
}
function MembersPage({ scope, resolved }: { scope: Scope; resolved: ResolvedScope }) {
  const services = useServices(), { session } = useSession(), [params, setParams] = useSearchParams();
  const cursor = params.get("memberCursor") ?? undefined, filter = params.get("memberFilter") ?? "";
  const key = scopeKey(session!.visibilityKey, scope);
  const query = useQuery({ queryKey: [...key, "members", cursor, filter], queryFn: async ({ signal }) => unwrap(await services.platform.listMembers({ scope, signal }, { limit: 5, cursor, filter: { name: filter } })) });
  const manageable = resolved.permissions["members.manage"].allowed;
  const projects = useQuery({ queryKey: [...key, "assignment-projects"], queryFn: async ({ signal }) => unwrap(await services.catalog.listProjects({ scope: { orgId: scope.orgId }, signal }, { limit: 100 })), enabled: manageable });
  const projectOptions = projects.data?.items ?? [];
  function change(name: string, value?: string) { const next = new URLSearchParams(params); value ? next.set(name, value) : next.delete(name); if (name === "memberFilter") next.delete("memberCursor"); setParams(next); }
  return <section><h2>{scope.projectId ? "Assignments and scoped grants" : "Members"}</h2>
    <p>Owners/Admins have all projects. Other roles require project assignment. Customer-data grants remain separate from configuration grants. Non-administrators see their own membership.</p>
    {manageable && <><p>Available projects: {projectOptions.map(p => `${p.name} (${p.id})`).join(", ") || "Create a project first to assign it."}</p>{projects.data?.nextCursor && <p>More than 100 projects exist. Use the project catalog to copy additional canonical IDs.</p>}{projects.error && <Feedback error={projects.error} retry={() => void projects.refetch()} />}
      <CommandForm title="Invite member" revision={resolved.organization.revision} fields={[{ name: "email", label: "Invitee email", type: "email" }, { name: "role", label: "Role", value: "Developer", options: choices(roles) }, { name: "projects", label: "Assigned project IDs (comma separated)", value: scope.projectId ?? "", required: false }]} submit={(v, o) => services.platform.command({ scope }, { kind: "invite", email: v.email, role: v.role as "Developer", projects: ids(v.projects) }, o)} />
    </>}
    <label>Filter members<input value={filter} onChange={e => change("memberFilter", e.target.value)} /></label>
    {query.isPending ? <p>Loading members…</p> : query.error ? <Feedback error={query.error} retry={() => { change("memberCursor"); void query.refetch(); }} /> : <>{!query.data.items.length && <p>No matching members.</p>}{query.data.items.map(member => <MemberCard key={member.id} member={member} scope={scope} resolved={resolved} manageable={manageable} />)}<Pager cursor={cursor} next={query.data.nextCursor} change={value => change("memberCursor", value)} /></>}
    {manageable && <Invitations scope={scope} />}
  </section>;
}
const ids = (value: string) => value.split(",").map(x => x.trim()).filter(Boolean);
function MemberCard({ member, scope, resolved, manageable }: { member: Member; scope: Scope; resolved: ResolvedScope; manageable: boolean }) {
  const services = useServices(), { session } = useSession();
  const denied = !manageable ? "Owner/Admin permission required." : member.role === "Owner" ? "Owner changes require accepted ownership transfer." : undefined;
  return <article><h3>{member.name} · {member.role}</h3><p>{member.email} · {member.id} · Revision {member.revision}</p><p>Projects: {member.projects.join(", ") || (["Owner", "Admin"].includes(member.role) ? "all" : "none")}</p>
    <ul>{member.grants.map((g, i) => <li key={i}>{g.permission} · {g.scope.projectId ?? "organization"} · {g.scope.environmentId ?? "all environments"}</li>)}</ul>
    {manageable && <>
      <CommandForm title={`Save membership for ${member.email}`} revision={member.revision} disabled={denied} fields={[{ name: "role", label: "Role", value: member.role === "Owner" ? "Admin" : member.role, options: choices(roles) }, { name: "projects", label: "Assigned project IDs (comma separated)", value: member.projects.join(", "), required: false }]} submit={(v, o) => services.platform.command({ scope }, { kind: "member-update", memberId: member.id, role: v.role as Exclude<Role, "Owner">, projects: ids(v.projects), grants: member.role === v.role ? member.grants.filter(g => !g.scope.projectId || ids(v.projects).includes(g.scope.projectId)) : [] }, o)}><p>Changing role clears previous explicit grants. Removing an assignment clears its grants.</p></CommandForm>
      <CommandForm title={`Add scoped grant for ${member.email}`} revision={member.revision} disabled={denied || (!["Admin", "Developer", "Viewer"].includes(member.role) ? "Explicit grants apply to Admin, Developer or Viewer roles." : undefined)} fields={[{ name: "permission", label: "Permission", value: "data.read", options: choices(member.role === "Viewer" ? ["data.read"] : member.role === "Admin" ? ["signing.manage"] : ["data.read", "data.write", "resources.configure", "release.publish", "audit.read", "projects.create", "build.cancel.any"]) }, { name: "project", label: "Project ID (empty for organization-wide grant)", value: scope.projectId ?? "", required: false }, { name: "environment", label: "Environment ID (empty for all assigned environments)", required: false }]} submit={(v, o) => services.platform.command({ scope }, { kind: "member-update", memberId: member.id, role: member.role as "Developer", projects: [...member.projects], grants: [...member.grants, { permission: v.permission as Permission, scope: { orgId: scope.orgId, ...(v.project ? { projectId: v.project } : {}), ...(v.environment ? { environmentId: v.environment } : {}) } }] }, o)}><p>A grant across all environments includes production. Select an exact environment to restrict it. Authorization is checked again by the adapter.</p></CommandForm>
      {!!member.grants.length && <CommandForm title={`Clear explicit grants for ${member.email}`} revision={member.revision} disabled={denied} submit={(_, o) => services.platform.command({ scope }, { kind: "member-update", memberId: member.id, role: member.role as "Developer", projects: [...member.projects], grants: [] }, o)} />}
      <CommandForm title={`Remove ${member.email}`} revision={member.revision} disabled={denied} fields={[{ name: "confirm", label: `Type ${member.email}` }]} submit={(v, o) => v.confirm !== member.email ? Promise.resolve({ ok: false, error: { code: "validation", message: "Email did not match.", requestId: "form" } }) : services.platform.command({ scope }, { kind: "member-remove", memberId: member.id }, o)}><p>Removes access and personal grants immediately. Organization-owned service accounts remain.</p></CommandForm>
    </>}
    {manageable && member.role !== "Owner" && member.accountId !== session!.accountId && <CommandForm title={`Propose ownership transfer to ${member.email}`} revision={resolved.organization.revision} fields={[{ name: "role", label: "Your role after acceptance", value: "Admin", options: choices(roles) }]} submit={(v, o) => services.platform.command({ scope }, { kind: "transfer", memberId: member.id, previousRole: v.role as "Admin" }, o)}><p>Only an Owner with fresh authentication can propose this transfer.</p></CommandForm>}
  </article>;
}
export function Invitations({ scope }: { scope?: Scope }) {
  const services = useServices(), { session } = useSession(), [params, setParams] = useSearchParams();
  const cursor = params.get("inviteCursor") ?? undefined;
  const query = useQuery({ queryKey: [...scopeKey(session!.visibilityKey, scope), "invitations", cursor], queryFn: async ({ signal }) => unwrap(await services.platform.listInvitations(scope ? { scope, signal } : undefined, { limit: 5, cursor })) });
  return <section><h2>{scope ? "Invitations" : "Your invitations"}</h2>{query.isPending ? <p>Loading invitations…</p> : query.error ? <Feedback error={query.error} retry={() => void query.refetch()} /> : <>{!query.data.items.length && <p>No invitations. New invitations are delivered to the local mock inbox.</p>}{query.data.items.map(i => <article key={i.id}><p>{i.email} · {i.role} · {i.status} · Expires {i.expiresAt}</p>{!scope && i.href && <Link to={i.href}>Review invitation</Link>}{scope && ["pending", "expired"].includes(i.status) && <>{(["invite-resend", "invite-cancel"] as const).map(kind => <CommandForm key={kind} title={kind === "invite-resend" ? `Resend ${i.email}` : `Cancel invitation for ${i.email}`} revision={i.revision} submit={(_, o) => services.platform.command({ scope }, { kind, invitationId: i.id }, o)} />)}</>}</article>)}<Pager cursor={cursor} next={query.data.nextCursor} change={value => { const next = new URLSearchParams(params); value ? next.set("inviteCursor", value) : next.delete("inviteCursor"); setParams(next); }} /></>}</section>;
}
export function EnvironmentControls({ scope, resolved }: { scope: Scope; resolved: ResolvedScope }) {
  const services = useServices(), navigate = useNavigate(); const env = resolved.environment!;
  const writable = resolved.permissions["resources.configure"], admin = resolved.permissions["organization.manage"];
  return <section><h2>Environment configuration</h2><p>Environment revision {env.revision}. Production confirmation: {env.requireProductionConfirmation === false ? "optional" : "required"}.</p>
    <CommandForm title="Enable environment resources" after={r => { if (r.operation) navigate(`${scopePath(scope)}/overview?operation=${r.operation.id}`); }} revision={resolved.organization.revision} disabled={writable.allowed ? undefined : writable.reason} fields={[{ name: "services", label: "Services", value: "database,auth,functions", options: [{ value: "database,auth,functions", label: "Database, Authentication and Functions" }, ...choices(["database", "auth", "functions"])] }, ...(env.kind === "production" ? [{ name: "confirm", label: `Production target: type ${env.name}`, required: env.requireProductionConfirmation !== false }] : [])]} submit={(v, o) => services.platform.command({ scope }, { kind: "provision", services: ids(v.services) as ("database" | "auth" | "functions")[], confirmation: v.confirm }, o)}><p>Creates isolated service bindings under this canonical environment. Open Tables and App users after provisioning completes. Open Functions to create a source draft and deploy a fixture.</p></CommandForm>
    <CommandForm title="Save environment policy" revision={env.revision} disabled={admin.allowed && writable.allowed ? undefined : "Active environment and Owner/Admin permission required."} fields={[{ name: "name", label: "Environment name", value: env.name }, { name: "confirm", label: "Require production target confirmation", value: String(env.requireProductionConfirmation !== false), options: choices(["true", "false"]) }]} submit={(v, o) => services.platform.command({ scope }, { kind: "environment-configure", name: v.name, requireProductionConfirmation: v.confirm === "true" }, o)} />
    <CommandForm title={env.status === "paused" ? "Resume environment" : "Pause environment"} revision={env.revision} disabled={admin.allowed ? undefined : admin.reason} fields={[{ name: "confirmation", label: `Type ${env.name}` }]} submit={(v, o) => services.platform.command({ scope }, { kind: "environment-pause", paused: env.status !== "paused", confirmation: v.confirmation }, o)}><p>Pausing refuses new mutations and deployments; bindings and existing release availability are retained. Active operations must finish or be cancelled first.</p></CommandForm>
  </section>;
}


