// Schema Migrations: an app developer's own versioned DDL against their
// project's schema, tracked in project_migrations (control-plane schema —
// distinct from carbon-database's OWN product-level migrations in
// infrastructure/persistence/migrations/, which this file has nothing to
// do with). Runs real DDL via DatabaseEngine.executeRawSql — the previous
// version routed through the SAME engine but that engine faked SQL
// execution; now both are real, so this file's own logic barely changed.

import type { DatabaseEngine } from "../services/DatabaseEngine.ts";

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: string;
  readonly sql: string;
}

export class MigrationEngine {
  constructor(
    private readonly sql: Bun.SQL,
    private readonly dbEngine: DatabaseEngine,
  ) {}

  async applyMigration(projectId: string, version: number, name: string, migrationSql: string): Promise<MigrationRecord> {
    const existing = await this.sql<Array<{ version: number }>>`
      SELECT version FROM project_migrations WHERE project_id = ${projectId} AND version = ${version}
    `;
    if (existing.length > 0) {
      throw new Error(`Migration version ${version} ("${name}") has already been applied`);
    }

    const statements = migrationSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await this.dbEngine.executeRawSql(projectId, stmt);
    }

    const appliedAt = new Date().toISOString();
    await this.sql`
      INSERT INTO project_migrations (project_id, version, name, sql, applied_at)
      VALUES (${projectId}, ${version}, ${name}, ${migrationSql}, ${appliedAt})
    `;

    return { version, name, appliedAt, sql: migrationSql };
  }

  async listMigrations(projectId: string): Promise<MigrationRecord[]> {
    const rows = await this.sql<Array<{ version: number; name: string; sql: string; applied_at: Date }>>`
      SELECT version, name, sql, applied_at FROM project_migrations WHERE project_id = ${projectId} ORDER BY version ASC
    `;
    return rows.map((r) => ({
      version: Number(r.version),
      name: r.name,
      appliedAt: new Date(r.applied_at).toISOString(),
      sql: r.sql,
    }));
  }
}
