import type { AppAuthEvent, AppSession, AppUser, Realm } from "../../../presentation/framework/services/app-auth-contracts";
import type { DataAccess, DataRow, DataTable, ImportInput, LocalDownload, RowValues, SavedQuery, SqlRun, Constraint } from "../../../presentation/framework/services/data-contracts";
import type { Permission, Scope } from "../../../presentation/framework/services/contracts";
import type { MockState } from "./store";

export type DataJob = { scope: Scope; sessionId: string; permission: Permission; tableId?: string; expectedRevision?: string; access?: DataAccess; deadline: number; confirmation?: string; policyRows?: RowValues[]; sqlColumns?: import("../../../presentation/framework/services/data-contracts").Column[]; payload: { kind: "import"; input: ImportInput } | { kind: "export"; rows: RowValues[]; filename: string } | { kind: "index"; constraint: Constraint } | { kind: "sql"; text: string; runId: string }; result?: { message: string; errors: { row: number; message: string }[]; download?: LocalDownload }; sqlRows?: RowValues[] };
export interface DataState {
  initialized: string[];
  tables: Record<string, DataTable>;
  rows: Record<string, DataRow>;
  queries: Record<string, SavedQuery>;
  sqlRuns: Record<string, SqlRun>;
  jobs: Record<string, DataJob>;
  realms: Record<string, Realm>;
  users: Record<string, AppUser>;
  sessions: Record<string, AppSession>;
  activeSessions: Record<string, string>;
  challenges: Record<string, { id: string; realmId: string; email: string; provider: "email" | "oauth"; redirect: string; expiresAt: string; consumed: boolean; subject: string; body: string }>;
  authEvents: Record<string, AppAuthEvent>;
}
export function dataState(state: MockState): DataState {
  state.data ??= { initialized: [], tables: {}, rows: {}, queries: {}, sqlRuns: {}, jobs: {}, realms: {}, users: {}, sessions: {}, activeSessions: {}, challenges: {}, authEvents: {} };
  const data = state.data;
  for (const env of Object.values(state.environments)) {
    const project = state.projects[env.projectId];
    if (!project || data.initialized.includes(env.id)) continue;
    data.initialized.push(env.id);
    const scope = { orgId: project.orgId, projectId: project.id, environmentId: env.id }, realmId = `realm_${env.id}`;
    data.realms[realmId] = { id: realmId, scope, revision: "r1", signup: false, magicLink: false, redirects: ["http://localhost:3000/callback"], sessionMinutes: 60, delivery: "unconfigured", sender: "no-reply@example.test", template: { subject: "Sign in to {{app}}", body: "Hello {{email}}, use {{link}}. Expires at {{expires}}." }, oauth: { enabled: false, clientId: "", secretId: "", callback: `/app-auth/${realmId}/callback`, linking: "deny" }, password: { available: false, version: 1, reason: "Password provider v1 is unavailable; this mock supports email magic links and OAuth fixtures." } };
    if (project.id !== "project_north_notes" || env.kind !== "development") continue;
    Object.assign(data.realms[realmId], { signup: true, magicLink: true, delivery: "verified" });
    const users = ["alice", "bob"].map((name, index) => {
      const id = `10000000-0000-4000-8000-00000000000${index}`;
      data.users[id] = { id, realmId, email: `${name}@example.test`, status: "active", verified: true, providers: ["email"], profile: { name }, claims: {}, createdAt: "2026-09-06T12:00:00.000Z", revision: "r1", sessionCount: 0 };
      return id;
    });
    const id = `table_${env.id}_notes`;
    data.tables[id] = { id, scope, name: "notes", schema: "public", revision: "r1", primaryKey: "id", columns: [{ name: "id", type: "uuid", nullable: false, default: { kind: "uuid" } }, { name: "owner_id", type: "text", nullable: false }, { name: "title", type: "text", nullable: false, default: { kind: "literal", value: "" } }, { name: "document", type: "jsonb", nullable: true }], rls: true, policies: [{ id: "owner", name: "Own notes", kind: "owner", ownerColumn: "owner_id", operations: ["select", "insert", "update", "delete"] }], constraints: [], actions: { configure: { allowed: false }, read: { allowed: false }, write: { allowed: false } } };
    users.forEach((userId, i) => { const rowId = `row_${id}_${i}`; data.rows[rowId] = { id: rowId, tableId: id, revision: "r1", values: { id: `00000000-0000-4000-8000-00000000000${i}`, owner_id: userId, title: i ? "Bob's private note" : "Alice's private note", document: { done: false, count: i, tags: ["fixture"] } } }; });
  }
  return data;
}
