import type { Grant, Permission, Principal, Role, Scope } from "@carbon/contracts/platform";

// Role ceilings govern delegation. They are not default grants: data, production,
// signing and other sensitive actions have separate preset/explicit-grant rules.
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  Owner: ["organization.manage", "members.manage", "projects.create", "metadata.read", "resources.configure", "data.read", "data.write", "release.publish", "build.cancel.any", "signing.manage", "billing.manage", "audit.read"],
  Admin: ["organization.manage", "members.manage", "projects.create", "metadata.read", "resources.configure", "data.read", "data.write", "release.publish", "build.cancel.any", "signing.manage", "audit.read"],
  Developer: ["projects.create", "metadata.read", "resources.configure", "data.read", "data.write", "release.publish", "build.cancel.any", "audit.read"],
  Viewer: ["metadata.read", "data.read"],
  Billing: ["billing.manage"],
};

const ROLE_PRESETS: Readonly<Record<Role, readonly Permission[]>> = {
  Owner: ROLE_PERMISSIONS.Owner,
  Admin: ROLE_PERMISSIONS.Admin.filter(permission => permission !== "signing.manage"),
  Developer: ["metadata.read", "resources.configure"],
  Viewer: ["metadata.read"],
  Billing: ["billing.manage"],
};
const RESOURCE_WRITES: readonly Permission[] = ["projects.create", "resources.configure", "data.write", "release.publish", "signing.manage"];

export function scopeContains(parent: Scope, child: Scope): boolean {
  return parent.orgId === child.orgId
    && (!parent.projectId || parent.projectId === child.projectId)
    && (!parent.environmentId || parent.environmentId === child.environmentId)
    && (!parent.realmId || parent.realmId === child.realmId);
}

export function sameScope(a: Scope, b: Scope): boolean {
  return scopeContains(a, b) && scopeContains(b, a);
}

export function hasGrant(grants: readonly Grant[], permission: Permission, scope: Scope): boolean {
  return grants.some(grant => grant.permission === permission && scopeContains(grant.scope, scope));
}

export interface MembershipAuthority {
  readonly accountId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly state: "active" | "revoked" | "invited";
  readonly permissionRevision: string;
  /** Owners/Admins default to all projects; other roles default to assigned. */
  readonly projectAccess?: "all" | "assigned";
  /** An empty assigned list means no projects, never all projects. */
  readonly projectIds: readonly string[];
  readonly grants: readonly Grant[];
}

/** Supplied by the authoritative resource repository, never by request fields. */
export interface ResourceAuthority {
  readonly organizationState: "active" | "suspended" | "deletion_pending" | "deleted";
  readonly projectState?: "active" | "archived" | "deletion_pending" | "deleted";
  readonly environmentState?: "active" | "paused" | "deletion_pending" | "deleted";
  readonly environmentKind?: "development" | "staging" | "production";
  readonly productionMutationAllowed?: boolean;
  readonly deniedPermissions?: readonly Permission[];
}

/** Resolve only account authority here; operators never inherit customer membership. */
export function accountGrants(principal: Principal, membership: MembershipAuthority, scope: Scope, resource: ResourceAuthority): readonly Grant[] {
  if (principal.kind !== "account" || principal.audience !== "dashboard"
    || principal.id !== membership.accountId || membership.state !== "active"
    || principal.permissionRevision !== membership.permissionRevision || membership.orgId !== scope.orgId) return [];
  if (resource.organizationState === "deleted" || (scope.environmentId && !scope.projectId)
    || (scope.projectId && (!resource.projectState || resource.projectState === "deleted"))
    || (scope.environmentId && (!resource.environmentState || !resource.environmentKind || resource.environmentState === "deleted"))) return [];
  const access = membership.projectAccess ?? (["Owner", "Admin"].includes(membership.role) ? "all" : "assigned");
  if (scope.projectId && access === "assigned" && !membership.projectIds.includes(scope.projectId)) return [];
  const explicit = membership.grants.filter(grant => ROLE_PERMISSIONS[membership.role].includes(grant.permission) && scopeContains(grant.scope, scope));
  const permissions = new Set(ROLE_PRESETS[membership.role]);
  if (membership.role === "Developer" && (!scope.projectId || resource.environmentKind === "production")) permissions.delete("resources.configure");
  if (membership.role !== "Billing") for (const grant of explicit) permissions.add(grant.permission);
  const writable = resource.organizationState === "active"
    && (!scope.projectId || resource.projectState === "active") && (!scope.environmentId || resource.environmentState === "active")
    && (resource.environmentKind !== "production" || resource.productionMutationAllowed === true);
  if (!writable) for (const permission of RESOURCE_WRITES) permissions.delete(permission);
  if (resource.organizationState !== 'active') {
    permissions.delete('organization.manage'); permissions.delete('members.manage');
  }
  for (const permission of resource.deniedPermissions ?? []) permissions.delete(permission);
  // Return only the resolved requested scope, not a broader stored parent grant.
  return [...permissions].map(permission => ({ permission, scope }));
}
