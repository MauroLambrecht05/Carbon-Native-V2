import type { Session } from "../../../../presentation/framework/services/contracts";
import { STORE_VERSION, type MockState } from "../store";
import { operationsState } from "../operations-state";

export const identities = [
  { id: "owner", name: "Alex · Owner of both tenants", audience: "dashboard" },
  {
    id: "developer",
    name: "Dee · Restricted developer",
    audience: "dashboard",
  },
  { id: "viewer", name: "Val · Viewer", audience: "dashboard" },
  { id: "billing", name: "Bill · Billing only", audience: "dashboard" },
  {
    id: "new",
    name: "New verified account · no organizations",
    audience: "dashboard",
  },
  {
    id: "operator",
    name: "Operator · no customer membership",
    audience: "operator",
  },
  {
    id: "app",
    name: "Application user · wrong dashboard audience",
    audience: "app",
  },
  {
    id: "worker",
    name: "Worker · wrong dashboard audience",
    audience: "worker",
  },
] as const;
export function seedFoundation(wallTime: number): MockState {
  const state: MockState = {
    schemaVersion: STORE_VERSION,
    revision: 1,
    nextId: 1,
    sequence: 0,
    accessRevision: 1,
    scenario: "foundation",
    clock: {
      anchor: Date.parse("2026-09-06T12:00:00.000Z"),
      wallAnchor: wallTime,
      paused: false,
    },
    latencyMs: 120,
    accounts: {},
    sessions: {},
    activeSessionId: null,
    organizations: {},
    memberships: {},
    projects: {},
    environments: {},
    bindings: {},
    operations: {},
    events: {},
    audits: {},
    idempotency: {},
    failure: null,
  };
  for (const identity of identities)
    state.accounts[identity.id] = { id: identity.id, name: identity.name };
  for (const tenant of ["north", "south"]) {
    const orgId = `org_${tenant}`;
    state.organizations[orgId] = {
      id: orgId,
      name: `Acme ${tenant === "north" ? "North" : "South"}`,
      revision: "r1",
    };
    state.memberships[`member_${tenant}_owner`] = {
      id: `member_${tenant}_owner`,
      orgId,
      accountId: "owner",
      role: "Owner",
      projects: [],
      grants: [],
      active: true,
    };
    for (const app of ["notes", "desk"]) {
      const projectId = `project_${tenant}_${app}`;
      state.projects[projectId] = {
        id: projectId,
        orgId,
        name: app === "notes" ? "Notes" : "Desk",
        slug: app,
        status: "ready",
        revision: "r1",
      };
      for (const kind of ["development", "staging", "production"] as const) {
        const environmentId = `env_${tenant}_${app}_${kind}`;
        state.environments[environmentId] = {
          id: environmentId,
          projectId,
          name: kind,
          kind,
          status: "ready",
          revision: "r1",
        };
        for (const owner of ["cloud", "database", "registry"] as const) {
          const id = `binding_${environmentId}_${owner}`;
          state.bindings[id] = {
            id,
            scope: { orgId, projectId, environmentId },
            owner,
            serviceResourceId: `mock_${id}`,
            state: "ready",
          };
        }
      }
    }
  }
  for (const [accountId, role] of [
    ["developer", "Developer"],
    ["viewer", "Viewer"],
    ["billing", "Billing"],
  ] as const) {
    state.memberships[`member_${accountId}`] = {
      id: `member_${accountId}`,
      orgId: "org_north",
      accountId,
      role,
      projects: role === "Billing" ? [] : ["project_north_notes"],
      grants: [],
      active: true,
    };
  }
  operationsState(state);
  return state;
}
export function fixtureSession(
  state: MockState,
  accountId: string,
  time: number,
): Session & { revoked: boolean } {
  const identity = identities.find((entry) => entry.id === accountId);
  if (!identity) throw new Error("Unknown fixture identity");
  return {
    id: `session_${state.nextId++}`,
    accountId,
    name: identity.name,
    audience: identity.audience,
    expiresAt: new Date(time + 3_600_000).toISOString(),
    visibilityKey: String(state.accessRevision),
    revoked: false,
  };
}
