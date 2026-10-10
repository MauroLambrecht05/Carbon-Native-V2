// Legacy policy compatibility adapter. Policies are read inside the row transaction
// under a shared advisory lock; policy writes take the matching exclusive lock.
// Canonical application identity and native PostgreSQL RLS remain separate work.
export type RlsAction = "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";
export interface RlsContext { readonly orgId: string; readonly userId?: string; readonly role?: string }
export interface RlsPolicy {
  readonly id: string; readonly name: string; readonly action: RlsAction;
  readonly ruleExpression?: string;
  readonly check: (context: RlsContext, record: Record<string, unknown>) => boolean;
}
export class InvalidRlsPolicyError extends Error {
  constructor() { super('Unsupported RLS policy; use an explicit supported rule and action'); }
}
export function compileLegacyPolicy(expression: string | undefined): RlsPolicy['check'] {
  switch (expression) {
    case 'true': return () => true;
    case 'false': return () => false;
    case 'auth.orgId == record.orgId': return (context, record) => context.role !== 'anon' && !!context.orgId && context.orgId === record.orgId;
    case 'auth.userId == record.userId': return (context, record) => context.role !== 'anon' && !!context.userId && context.userId === record.userId;
    case 'record.is_public == true': return (_context, record) => record.is_public === true;
    default: throw new InvalidRlsPolicyError();
  }
}
const actions = new Set<string>(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL']);

export class RlsPolicySnapshot {
  constructor(readonly enabled: boolean, readonly policies: readonly RlsPolicy[], private readonly valid: boolean) {}
  allows(action: Exclude<RlsAction, 'ALL'>, context: RlsContext, record: Record<string, unknown>): boolean {
    // Public compatibility access requires explicit RLS enablement. Administrative
    // routes omit policy context only after their separate ownership check.
    if (!this.enabled || !this.valid) return false;
    return this.policies.some(policy => {
      if (policy.action !== action && policy.action !== 'ALL') return false;
      try { return policy.check(context, record) === true; } catch { return false; }
    });
  }
}

export class RlsPolicyEngine {
  constructor(private readonly sql: Bun.SQL) {}
  // Retained for compatibility with the composition root. No process-local cache.
  async loadAll(): Promise<void> { await this.sql`SELECT 1 FROM rls_settings LIMIT 1`; }
  private async lock(tx: Bun.TransactionSQL, projectId: string, tableName: string, exclusive: boolean) {
    const key = JSON.stringify([projectId, tableName]);
    if (exclusive) await tx`SELECT pg_advisory_xact_lock(1128354373, hashtext(${key}))`;
    else await tx`SELECT pg_advisory_xact_lock_shared(1128354373, hashtext(${key}))`;
  }
  private async requireTable(tx: Bun.TransactionSQL, projectId: string, tableName: string) {
    if (!(await tx`SELECT 1 FROM carbon_tables WHERE project_id = ${projectId} AND table_name = ${tableName}`).length) throw new Error('Table not found');
  }
  async snapshot(tx: Bun.TransactionSQL, projectId: string, tableName: string): Promise<RlsPolicySnapshot> {
    await this.lock(tx, projectId, tableName, false);
    const settings = await tx`SELECT enabled FROM rls_settings WHERE project_id = ${projectId} AND table_name = ${tableName}`;
    const rows = await tx<Array<{ id: string; name: string; action: RlsAction; rule_expression: string | null }>>`SELECT id, name, action, rule_expression FROM rls_policies WHERE project_id = ${projectId} AND table_name = ${tableName} ORDER BY id`;
    let valid = true;
    const policies: RlsPolicy[] = rows.map(row => {
      let check: RlsPolicy['check'] = () => false;
      try { if (!actions.has(row.action)) throw new InvalidRlsPolicyError(); check = compileLegacyPolicy(row.rule_expression ?? undefined); }
      catch { valid = false; }
      return { id: row.id, name: row.name, action: row.action, ruleExpression: row.rule_expression ?? undefined, check };
    });
    return new RlsPolicySnapshot(settings[0]?.enabled === true, policies, valid);
  }
  async describe(projectId: string, tableName: string) {
    return this.sql.begin(async tx => {
      const snapshot = await this.snapshot(tx, projectId, tableName);
      return { enabled: snapshot.enabled, policies: snapshot.policies };
    });
  }
  async isRlsEnabled(projectId: string, tableName: string): Promise<boolean> { return (await this.describe(projectId, tableName)).enabled; }
  async listPolicies(projectId: string, tableName: string): Promise<readonly RlsPolicy[]> { return (await this.describe(projectId, tableName)).policies; }
  async setRlsEnabled(projectId: string, tableName: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new InvalidRlsPolicyError();
    await this.sql.begin(async tx => {
      await this.lock(tx, projectId, tableName, true); await this.requireTable(tx, projectId, tableName);
      await tx`INSERT INTO rls_settings (project_id, table_name, enabled) VALUES (${projectId}, ${tableName}, ${enabled})
        ON CONFLICT (project_id, table_name) DO UPDATE SET enabled = EXCLUDED.enabled`;
    });
  }
  async addPolicy(projectId: string, tableName: string, policy: { id: string; name: string; action: RlsAction; ruleExpression?: string }): Promise<void> {
    compileLegacyPolicy(policy.ruleExpression);
    if (!actions.has(policy.action) || !policy.id || !policy.name || policy.id.length > 128 || policy.name.length > 128) throw new InvalidRlsPolicyError();
    await this.sql.begin(async tx => {
      await this.lock(tx, projectId, tableName, true); await this.requireTable(tx, projectId, tableName);
      await tx`INSERT INTO rls_policies (id, project_id, table_name, name, action, rule_expression)
        VALUES (${policy.id}, ${projectId}, ${tableName}, ${policy.name}, ${policy.action}, ${policy.ruleExpression!})`;
    });
  }
  async removePolicy(projectId: string, tableName: string, policyId: string): Promise<boolean> {
    return this.sql.begin(async tx => {
      await this.lock(tx, projectId, tableName, true);
      return (await tx`DELETE FROM rls_policies WHERE id = ${policyId} AND project_id = ${projectId} AND table_name = ${tableName} RETURNING id`).length > 0;
    });
  }
  async clearTablePolicies(tx: Bun.TransactionSQL, projectId: string, tableName: string): Promise<void> {
    await this.lock(tx, projectId, tableName, true);
    await tx`DELETE FROM rls_policies WHERE project_id = ${projectId} AND table_name = ${tableName}`;
    await tx`DELETE FROM rls_settings WHERE project_id = ${projectId} AND table_name = ${tableName}`;
  }
}
