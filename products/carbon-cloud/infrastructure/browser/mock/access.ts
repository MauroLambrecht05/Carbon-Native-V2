import type {
  Action,
  Permission,
  Permissions,
  ResolvedScope,
  Scope,
  Session,
} from "../../../presentation/framework/services/contracts";
import type { MockState } from "./store";
import { now } from "./clock";
import { identityState } from "./identity-state";

export class Refusal extends Error {
  constructor(
    readonly code:
      | "unauthenticated"
      | "forbidden"
      | "not_found"
      | "validation"
      | "conflict"
      | "cancelled"
      | "quota_exceeded"
      | "unsupported_operation",
    message: string,
  ) {
    super(message);
  }
}
export function currentSession(state: MockState, wall: number): Session | null {
  const session = state.activeSessionId
    ? state.sessions[state.activeSessionId]
    : undefined;
  if (
    !session ||
    session.revoked ||
    Date.parse(session.expiresAt) <= now(state.clock, wall)
  )
    return null;
  const { revoked: _, ...dto } = session;
  return { ...dto, visibilityKey: `${session.id}:${state.accessRevision}` };
}
export function requireSession(state: MockState, wall: number): Session {
  const session = currentSession(state, wall);
  if (!session)
    throw new Refusal(
      "unauthenticated",
      "Sign in or reauthenticate after session expiry.",
    );
  if (session.audience !== "dashboard")
    throw new Refusal(
      "forbidden",
      `The ${session.audience} audience cannot administer customer resources.`,
    );
  return session;
}
export function containsScope(parent: Scope, child: Scope): boolean {
  return (
    parent.orgId === child.orgId &&
    (!parent.projectId || parent.projectId === child.projectId) &&
    (!parent.environmentId || parent.environmentId === child.environmentId)
  );
}
export function resolveScope(
  state: MockState,
  scope: Scope,
  wall: number,
): ResolvedScope {
  const session = requireSession(state, wall);
  if (!scope.orgId || (scope.environmentId && !scope.projectId))
    throw new Refusal(
      "validation",
      "An environment scope requires its organization and project.",
    );
  const membership = Object.values(state.memberships).find(
    (m) =>
      m.active && m.accountId === session.accountId && m.orgId === scope.orgId,
  );
  const organization = state.organizations[scope.orgId];
  if (!membership || !organization)
    throw new Refusal("not_found", "Organization not found.");
  const identity = identityState(state);
  if (identity.organizations[organization.id]?.requireMfa &&
      (!identity.accounts[session.accountId]?.mfa || !identity.sessionDetails[session.id]?.mfa))
    throw new Refusal("forbidden", "This organization requires an MFA-verified session. Enroll MFA in account security and sign in again.");
  const elevated = membership.role === "Owner" || membership.role === "Admin";
  const project = scope.projectId ? state.projects[scope.projectId] : undefined;
  if (
    scope.projectId &&
    (!project ||
      project.orgId !== organization.id ||
      (!elevated && !membership.projects.includes(project.id)))
  )
    throw new Refusal("not_found", "Project not found.");
  const environment = scope.environmentId
    ? state.environments[scope.environmentId]
    : undefined;
  if (
    scope.environmentId &&
    (!environment || environment.projectId !== project?.id)
  )
    throw new Refusal("not_found", "Environment not found.");
  const production = environment?.kind === "production";
  const granted = (permission: Permission) =>
    membership.grants.some(
      (g) => g.permission === permission && containsScope(g.scope, scope),
    );
  const action = (
    allowed: boolean,
    reason = "Your membership does not grant this action.",
  ): Action => (allowed ? { allowed } : { allowed, reason });
  const permissions: Permissions = {
    "organization.manage": action(elevated),
    "members.manage": action(elevated),
    "projects.create": action(elevated || (membership.role === "Developer" && granted("projects.create"))),
    "metadata.read": action(
      membership.role !== "Billing",
      "Billing membership exposes usage only.",
    ),
    "resources.configure": action(
      elevated ||
        (membership.role === "Developer" && !production && !!project) ||
        (membership.role === "Developer" && granted("resources.configure")),
      production
        ? "Production changes require a production grant and policy check."
        : undefined,
    ),
    "data.read": action(
      elevated || (["Developer", "Viewer"].includes(membership.role) && granted("data.read")),
      "Customer data access requires a separate scoped grant.",
    ),
    "data.write": action(
      elevated || (membership.role === "Developer" && granted("data.write")),
    ),
    "release.publish": action(elevated || (membership.role === "Developer" && granted("release.publish"))),
    "build.cancel.any": action(elevated || (membership.role === "Developer" && granted("build.cancel.any"))),
    "signing.manage": action(membership.role === "Owner" || (membership.role === "Admin" && granted("signing.manage")), "Signing changes require Owner access or an explicit Admin signing grant."),
    "billing.manage": action(
      membership.role === "Owner" || membership.role === "Billing",
    ),
    "audit.read": action(elevated || granted("audit.read")),
  };
  if (environment?.status === "paused" || project?.status === "archived") {
    for (const permission of ["resources.configure", "data.write", "release.publish"] as const)
      Object.assign(permissions[permission], { allowed: false, reason: "This resource is paused or archived. An administrator must resume it first." });
  }
  if (["suspended", "deletion_scheduled"].includes(state.operationsAdmin?.organizations[organization.id]?.state ?? "active")) {
    for (const permission of ["resources.configure", "data.write", "release.publish"] as const)
      Object.assign(permissions[permission], { allowed: false, reason: "Platform suspension blocks charged writes while authorized read and recovery paths remain available." });
  }
  return {
    organization,
    project,
    environment,
    permissions,
    bindings: permissions["metadata.read"].allowed
      ? Object.values(state.bindings).filter(
          (binding) =>
            containsScope(scope, binding.scope) &&
            (elevated ||
              membership.projects.includes(binding.scope.projectId ?? "")),
        )
      : [],
  };
}
export function requirePermission(
  state: MockState,
  scope: Scope,
  permission: Permission,
  wall: number,
): ResolvedScope {
  const resolved = resolveScope(state, scope, wall);
  const action = resolved.permissions[permission];
  if (!action.allowed) throw new Refusal("forbidden", action.reason!);
  return resolved;
}
