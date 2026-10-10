import { expect, test } from "bun:test";
import type { Grant, Permission, Role } from "@carbon/contracts/platform";
import { ids, principal, scope } from "../../../../contracts/platform/fixtures/conformance.ts";
import { accountGrants, hasGrant, type MembershipAuthority, type ResourceAuthority } from "../domain/policies/PlatformAuthorization.ts";

const resource: ResourceAuthority = { organizationState: "active", projectState: "active", environmentState: "active", environmentKind: "development" };
function membership(role: Role, grants: readonly Grant[] = []): MembershipAuthority {
  return { accountId: ids.account, orgId: ids.org, permissionRevision: "1", state: "active", role, projectIds: [ids.project], grants };
}
const allowed = (role: Role, permission: Permission, grants: readonly Grant[] = [], state = resource) => hasGrant(accountGrants(principal, membership(role, grants), scope, state), permission, scope);

test("role presets require explicit Developer/Viewer data and release grants, and explicit Admin signing", () => {
  for (const role of ["Owner", "Admin"] as const) for (const permission of ["data.read", "data.write", "release.publish"] as const) expect(allowed(role, permission)).toBe(true);
  for (const role of ["Developer", "Viewer", "Billing"] as const) for (const permission of ["data.read", "data.write", "release.publish"] as const) expect(allowed(role, permission)).toBe(false);
  expect(allowed("Developer", "resources.configure")).toBe(true);
  expect(allowed("Viewer", "resources.configure")).toBe(false);
  expect(allowed("Admin", "signing.manage")).toBe(false);
  expect(allowed("Admin", "signing.manage", [{ permission: "signing.manage", scope }])).toBe(true);
  expect(allowed("Admin", "organization.manage")).toBe(true);
  expect(allowed("Admin", "billing.manage")).toBe(false);
});

test("empty assignments mean no project access; only Owner/Admin default to all", () => {
  for (const role of ["Developer", "Viewer", "Billing"] as const) {
    expect(accountGrants(principal, { ...membership(role), projectIds: [] }, scope, resource)).toEqual([]);
  }
  for (const role of ["Owner", "Admin"] as const) {
    expect(accountGrants(principal, { ...membership(role), projectIds: [] }, scope, resource).length).toBeGreaterThan(0);
    expect(accountGrants(principal, { ...membership(role), projectIds: [], projectAccess: "assigned" }, scope, resource)).toEqual([]);
  }
  expect(accountGrants(principal, { ...membership("Developer"), projectIds: [], projectAccess: "all" }, scope, resource).length).toBeGreaterThan(0);
});

test("custom grants cannot escape role ceilings, project assignment or the requested scope", () => {
  const grant: Grant = { permission: "data.read", scope: { orgId: ids.org } };
  expect(allowed("Viewer", "data.read", [grant])).toBe(true);
  expect(allowed("Viewer", "data.write", [{ permission: "data.write", scope }])).toBe(false);
  expect(allowed("Developer", "signing.manage", [{ permission: "signing.manage", scope }])).toBe(false);
  expect(allowed("Billing", "data.read", [grant])).toBe(false);
  expect(allowed("Developer", "data.read", [{ ...grant, scope: { orgId: ids.account } }])).toBe(false);
  expect(accountGrants(principal, { ...membership("Developer", [grant]), projectIds: [] }, scope, resource)).toEqual([]);
  const grants = accountGrants(principal, membership("Developer", [grant]), scope, resource);
  expect(grants.find(g => g.permission === "data.read")!.scope).toEqual(scope);
});

test("production needs explicit Developer configuration permission and project policy even for administrators", () => {
  const production: ResourceAuthority = { ...resource, environmentKind: "production", productionMutationAllowed: true };
  expect(allowed("Developer", "resources.configure", [], production)).toBe(false);
  expect(allowed("Developer", "resources.configure", [{ permission: "resources.configure", scope }], production)).toBe(true);
  for (const role of ["Owner", "Admin", "Developer"] as const) expect(allowed(role, "resources.configure", [{ permission: "resources.configure", scope }], { ...production, productionMutationAllowed: false })).toBe(false);
  expect(allowed("Owner", "resources.configure", [], production)).toBe(true);
});

test("paused, archived and suspended resources retain allowed reads while denying writes; unknown or deleted scope fails closed", () => {
  for (const state of [{ ...resource, environmentState: "paused" }, { ...resource, projectState: "archived" }, { ...resource, organizationState: "suspended" }] as ResourceAuthority[]) {
    expect(allowed("Owner", "data.read", [], state)).toBe(true);
    expect(allowed("Owner", "data.write", [], state)).toBe(false);
    expect(allowed("Owner", "release.publish", [], state)).toBe(false);
  }
  for (const state of [{ organizationState: "active" }, { ...resource, environmentState: "deleted" }, { ...resource, projectState: "deleted" }, { ...resource, organizationState: "deleted" }] as ResourceAuthority[]) {
    expect(accountGrants(principal, membership("Owner"), scope, state)).toEqual([]);
  }
  expect(allowed("Admin", "data.read", [], { ...resource, deniedPermissions: ["data.read"] })).toBe(false);
  expect(allowed("Owner", "organization.manage", [], { ...resource, organizationState: 'suspended' })).toBe(false);
  expect(allowed("Admin", "members.manage", [], { ...resource, organizationState: 'deletion_pending' })).toBe(false);
});
