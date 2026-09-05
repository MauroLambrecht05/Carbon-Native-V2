// Serverless Edge Functions: deployed function CODE, env vars, and
// invocation-count metadata are real Postgres rows (edge_functions — see
// 0001_init.sql) so a deploy survives a restart. EXECUTION was already
// genuinely real in the in-memory version (a real `AsyncFunction` runner,
// not a simulation) and stays exactly as it was — only persistence of
// what got deployed changed.

export interface EdgeFunctionMeta {
  readonly name: string;
  readonly code: string;
  readonly envVars: Record<string, string>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly invocations: number;
}

export interface InvocationResult {
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly executionTimeMs: number;
  readonly timestamp: Date;
}

export class EdgeFunctionsEngine {
  constructor(private readonly sql: Bun.SQL) {}

  async deployFunction(
    projectId: string,
    name: string,
    code: string,
    envVars: Record<string, string> = {},
  ): Promise<EdgeFunctionMeta> {
    const existing = await this.getFunction(projectId, name);
    const now = new Date();

    if (existing) {
      const mergedEnv = { ...existing.envVars, ...envVars };
      // NOT JSON.stringify — see DatabaseEngine.createTable's identical
      // comment on why that double-encodes a jsonb column; verified the
      // same fix (raw value + explicit ::jsonb cast) against real
      // Postgres there.
      await this.sql`
        UPDATE edge_functions SET code = ${code}, env_vars = ${mergedEnv}::jsonb, updated_at = ${now}
        WHERE project_id = ${projectId} AND name = ${name}
      `;
      return { ...existing, code, envVars: mergedEnv, updatedAt: now };
    }

    await this.sql`
      INSERT INTO edge_functions (project_id, name, code, env_vars, created_at, updated_at, invocations)
      VALUES (${projectId}, ${name}, ${code}, ${envVars}::jsonb, ${now}, ${now}, 0)
    `;
    return { name, code, envVars, createdAt: now, updatedAt: now, invocations: 0 };
  }

  async getFunction(projectId: string, name: string): Promise<EdgeFunctionMeta | undefined> {
    const rows = await this.sql<
      Array<{ code: string; env_vars: Record<string, string>; created_at: Date; updated_at: Date; invocations: number }>
    >`
      SELECT code, env_vars, created_at, updated_at, invocations FROM edge_functions
      WHERE project_id = ${projectId} AND name = ${name}
    `;
    const row = rows[0];
    if (!row) return undefined;
    return {
      name,
      code: row.code,
      envVars: row.env_vars,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      invocations: Number(row.invocations),
    };
  }

  async listFunctions(
    projectId: string,
  ): Promise<{ name: string; invocations: number; createdAt: Date; updatedAt: Date }[]> {
    const rows = await this.sql<Array<{ name: string; invocations: number; created_at: Date; updated_at: Date }>>`
      SELECT name, invocations, created_at, updated_at FROM edge_functions WHERE project_id = ${projectId} ORDER BY name
    `;
    return rows.map((r) => ({
      name: r.name,
      invocations: Number(r.invocations),
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }));
  }

  async deleteFunction(projectId: string, name: string): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM edge_functions WHERE project_id = ${projectId} AND name = ${name} RETURNING name
    `;
    return result.length > 0;
  }

  async invokeFunction(
    projectId: string,
    name: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<InvocationResult> {
    const func = await this.getFunction(projectId, name);
    if (!func) throw new Error(`Edge function "${name}" not found in project "${projectId}"`);

    const start = performance.now();
    await this.sql`
      UPDATE edge_functions SET invocations = invocations + 1 WHERE project_id = ${projectId} AND name = ${name}
    `;

    try {
      const req = { body: payload, headers, timestamp: new Date().toISOString() };
      const env = { ...func.envVars };
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      const runner = new AsyncFunction("req", "env", func.code);
      const result = await runner(req, env);
      return { success: true, result: result ?? { ok: true }, executionTimeMs: performance.now() - start, timestamp: new Date() };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
        executionTimeMs: performance.now() - start,
        timestamp: new Date(),
      };
    }
  }
}
