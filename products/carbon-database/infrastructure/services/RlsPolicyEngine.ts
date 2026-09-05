// Row-Level Security (RLS) Policy Engine: Declarative access control
// evaluated against verified Carbon Identity tokens.
//
// PERSISTED, WRITE-THROUGH CACHED: policies and enabled/disabled state are
// real rows in Postgres (rls_settings/rls_policies — see 0001_init.sql),
// but `canSelect`/`canInsert`/`canUpdate`/`canDelete` stay SYNCHRONOUS: they
// run once per ROW inside DatabaseEngine's already-async query/mutation
// methods, and making each individual row-check its own await would be
// both slower and unnecessary — the policy SET for a table changes rarely
// (an explicit `POST .../rls` call), unlike the rows being checked
// against it. `loadAll()` populates the cache once at startup (called
// from composition, same as running migrations once); every write method
// updates Postgres AND the cache together so the two never drift apart
// within a running process.
//
// `check` is NOT an arbitrary expression language — `ruleExpression` is
// one of a small, known set of canned forms (see buildCheckFn), matching
// what the HTTP layer has ever accepted for `POST .../policies`. This is
// the same scope the in-memory version had; only persistence changed.

export type RlsAction = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";

export interface RlsContext {
  readonly orgId: string;
  readonly userId?: string;
  readonly role?: string; // e.g. "admin", "authenticated", "anon"
}

export interface RlsPolicy {
  readonly id: string;
  readonly name: string;
  readonly action: RlsAction;
  readonly ruleExpression?: string;
  readonly check: (context: RlsContext, record: Record<string, unknown>) => boolean;
}

/** The small, known set of rule forms `POST .../policies` has ever accepted. */
function buildCheckFn(ruleExpression: string | undefined): RlsPolicy["check"] {
  if (!ruleExpression) return () => true;
  if (ruleExpression === "auth.orgId == record.orgId") {
    return (ctx, record) => ctx.orgId === record.orgId;
  }
  if (ruleExpression === "record.is_public == true") {
    return (_ctx, record) => record.is_public === true;
  }
  return () => true;
}

export class RlsPolicyEngine {
  private readonly rlsEnabled = new Map<string, boolean>(); // "projectId:tableName" -> enabled
  private readonly policies = new Map<string, RlsPolicy[]>(); // "projectId:tableName" -> policies

  constructor(private readonly sql: Bun.SQL) {}

  private tableKey(projectId: string, tableName: string): string {
    return `${projectId}:${tableName}`;
  }

  /** Populates the in-memory cache from Postgres. Call once at startup. */
  async loadAll(): Promise<void> {
    const settings = await this.sql<Array<{ project_id: string; table_name: string; enabled: boolean }>>`
      SELECT project_id, table_name, enabled FROM rls_settings
    `;
    for (const s of settings) {
      this.rlsEnabled.set(this.tableKey(s.project_id, s.table_name), s.enabled);
    }

    const policyRows = await this.sql<
      Array<{
        id: string;
        project_id: string;
        table_name: string;
        name: string;
        action: RlsAction;
        rule_expression: string | null;
      }>
    >`SELECT id, project_id, table_name, name, action, rule_expression FROM rls_policies`;
    for (const p of policyRows) {
      const key = this.tableKey(p.project_id, p.table_name);
      const list = this.policies.get(key) ?? [];
      list.push({
        id: p.id,
        name: p.name,
        action: p.action,
        ruleExpression: p.rule_expression ?? undefined,
        check: buildCheckFn(p.rule_expression ?? undefined),
      });
      this.policies.set(key, list);
    }
  }

  async setRlsEnabled(projectId: string, tableName: string, enabled: boolean): Promise<void> {
    await this.sql`
      INSERT INTO rls_settings (project_id, table_name, enabled) VALUES (${projectId}, ${tableName}, ${enabled})
      ON CONFLICT (project_id, table_name) DO UPDATE SET enabled = EXCLUDED.enabled
    `;
    this.rlsEnabled.set(this.tableKey(projectId, tableName), enabled);
  }

  isRlsEnabled(projectId: string, tableName: string): boolean {
    return this.rlsEnabled.get(this.tableKey(projectId, tableName)) ?? false;
  }

  async addPolicy(
    projectId: string,
    tableName: string,
    policy: { id: string; name: string; action: RlsAction; ruleExpression?: string },
  ): Promise<void> {
    await this.sql`
      INSERT INTO rls_policies (id, project_id, table_name, name, action, rule_expression)
      VALUES (${policy.id}, ${projectId}, ${tableName}, ${policy.name}, ${policy.action}, ${policy.ruleExpression ?? null})
    `;
    const key = this.tableKey(projectId, tableName);
    const list = this.policies.get(key) ?? [];
    list.push({
      id: policy.id,
      name: policy.name,
      action: policy.action,
      ruleExpression: policy.ruleExpression,
      check: buildCheckFn(policy.ruleExpression),
    });
    this.policies.set(key, list);
  }

  listPolicies(projectId: string, tableName: string): RlsPolicy[] {
    return this.policies.get(this.tableKey(projectId, tableName)) || [];
  }

  async removePolicy(projectId: string, tableName: string, policyId: string): Promise<boolean> {
    const key = this.tableKey(projectId, tableName);
    const existing = this.policies.get(key);
    if (!existing) return false;
    const initialLen = existing.length;
    const filtered = existing.filter((p) => p.id !== policyId);
    this.policies.set(key, filtered);
    if (filtered.length < initialLen) {
      await this.sql`DELETE FROM rls_policies WHERE id = ${policyId}`;
      return true;
    }
    return false;
  }

  private evaluateAction(
    projectId: string,
    tableName: string,
    action: RlsAction,
    context: RlsContext,
    record: Record<string, unknown>,
  ): boolean {
    if (!this.isRlsEnabled(projectId, tableName)) return true;

    const key = this.tableKey(projectId, tableName);
    const tablePolicies = this.policies.get(key) || [];
    const applicable = tablePolicies.filter((p) => p.action === action || p.action === "ALL");
    if (applicable.length === 0) return false; // enabled, no policy for this action: default deny

    return applicable.some((p) => {
      try {
        return p.check(context, record);
      } catch {
        return false;
      }
    });
  }

  canSelect(projectId: string, tableName: string, context: RlsContext, record: Record<string, unknown>): boolean {
    return this.evaluateAction(projectId, tableName, "SELECT", context, record);
  }
  canInsert(projectId: string, tableName: string, context: RlsContext, record: Record<string, unknown>): boolean {
    return this.evaluateAction(projectId, tableName, "INSERT", context, record);
  }
  canUpdate(projectId: string, tableName: string, context: RlsContext, record: Record<string, unknown>): boolean {
    return this.evaluateAction(projectId, tableName, "UPDATE", context, record);
  }
  canDelete(projectId: string, tableName: string, context: RlsContext, record: Record<string, unknown>): boolean {
    return this.evaluateAction(projectId, tableName, "DELETE", context, record);
  }
}
