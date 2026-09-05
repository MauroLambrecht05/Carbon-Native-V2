// Real relational storage: one Postgres SCHEMA per project ("proj_<id>",
// created on first use), user-defined tables inside it as REAL Postgres
// tables via real dynamic DDL — not a simulation of one. `executeRawSql`
// is genuinely `sql.unsafe(...)` against that schema, not a hand-rolled
// regex SQL parser (the previous in-memory version's approach) — running
// real Postgres is simpler AND more correct than re-implementing a SQL
// subset by hand.
//
// IDENTIFIER SAFETY: table/column names are app-developer-supplied over
// the HTTP API and can't be bound as query parameters (Postgres doesn't
// allow that for identifiers) — every one is validated via
// identifiers.ts's assertValidIdentifier/quoteIdent before being spliced
// into a query. This is load-bearing, not decoration — see that file's
// own header comment.
//
// CATALOG: carbon_tables (control-plane schema, not the per-project one)
// stores each table's ORIGINAL ColumnDefinition[] as JSON — the source of
// truth for "what type did the app declare this column as", since a real
// Postgres type (e.g. `double precision`) doesn't losslessly round-trip
// back to the app-level enum (`"number"`) otherwise.
//
// RLS: enforced in the application layer (RlsPolicyEngine), evaluated
// against real rows fetched from Postgres — not native Postgres RLS. This
// is a deliberate scope decision: native RLS needs a `SET LOCAL` session
// variable inside the SAME transaction as every query, which is real,
// buildable work, but a materially larger piece than this pass — the
// CURRENT policy engine (canSelect/canInsert/canUpdate/canDelete) was
// already a legitimate, correct authorization layer before this file
// changed; only the rows it evaluates against are now real.

import { assertValidIdentifier, quoteIdent, projectSchema } from "../persistence/identifiers.ts";
import { RealtimeEngine } from "./RealtimeEngine.ts";
import { RlsPolicyEngine, type RlsContext } from "./RlsPolicyEngine.ts";

export type ColumnType = "string" | "number" | "boolean" | "json" | "timestamp";

export interface ColumnDefinition {
  readonly name: string;
  readonly type: ColumnType;
  readonly primaryKey?: boolean;
  readonly nullable?: boolean;
  readonly defaultValue?: unknown;
}

export interface TableMeta {
  readonly name: string;
  readonly columns: ColumnDefinition[];
  readonly createdAt: Date;
}

export interface QueryOptions {
  readonly filter?: Record<string, unknown>;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: string;
  readonly orderDirection?: "asc" | "desc";
}

export interface QueryResult {
  readonly rows: Record<string, unknown>[];
  readonly total: number;
}

export interface RawSqlResult {
  readonly columns: string[];
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
  readonly command: string;
  readonly executionTimeMs: number;
}

const PG_TYPE: Record<ColumnType, string> = {
  string: "text",
  number: "double precision",
  boolean: "boolean",
  json: "jsonb",
  timestamp: "timestamptz",
};

export class DatabaseEngine {
  constructor(
    private readonly sql: Bun.SQL,
    private readonly realtime: RealtimeEngine,
    private readonly rls: RlsPolicyEngine,
  ) {}

  private async ensureSchema(projectId: string): Promise<string> {
    const schema = projectSchema(projectId);
    await this.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    return schema;
  }

  async createTable(projectId: string, tableName: string, columns: ColumnDefinition[]): Promise<TableMeta> {
    assertValidIdentifier(tableName, "table name");
    const existing = await this.getTable(projectId, tableName);
    if (existing) {
      throw new Error(`Table "${tableName}" already exists in project "${projectId}"`);
    }

    const hasPk = columns.some((c) => c.primaryKey);
    const finalColumns: ColumnDefinition[] = hasPk
      ? [...columns]
      : [{ name: "id", type: "string", primaryKey: true }, ...columns];

    for (const c of finalColumns) assertValidIdentifier(c.name, "column name");

    const schema = await this.ensureSchema(projectId);
    const colDefs = finalColumns
      .map((c) => {
        const parts = [quoteIdent(c.name, "column name"), PG_TYPE[c.type]];
        if (c.primaryKey) parts.push("PRIMARY KEY");
        else if (c.nullable === false) parts.push("NOT NULL");
        return parts.join(" ");
      })
      .join(", ");

    await this.sql.unsafe(`CREATE TABLE "${schema}".${quoteIdent(tableName, "table name")} (${colDefs})`);

    const createdAt = new Date();
    // NOT JSON.stringify(finalColumns) here — Bun's tagged-template `sql`
    // already encodes a bound JS value for an explicit `::jsonb` cast;
    // pre-stringifying double-encodes it into a jsonb column holding a
    // JSON STRING SCALAR instead of the array, so `.columns` comes back
    // as a string later (`.find`/`.length` then silently operate on
    // characters, not array elements). Verified directly against a real
    // running Postgres container (`psql ... pg_typeof(columns)` showed
    // `jsonb` holding the STRING `"[{\"name\":...` for a 3-column table,
    // `columnCount: 135` — the string's character count) — not assumed.
    // Same class of bug carbon-cloud's own README documents for
    // PostgresBuildRepository.save(); fixed the same way there too.
    await this.sql`
      INSERT INTO carbon_tables (project_id, table_name, columns, created_at)
      VALUES (${projectId}, ${tableName}, ${finalColumns}::jsonb, ${createdAt})
    `;

    return { name: tableName, columns: finalColumns, createdAt };
  }

  async getTable(projectId: string, tableName: string): Promise<TableMeta | undefined> {
    const rows = await this.sql<Array<{ columns: ColumnDefinition[]; created_at: Date }>>`
      SELECT columns, created_at FROM carbon_tables WHERE project_id = ${projectId} AND table_name = ${tableName}
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { name: tableName, columns: row.columns, createdAt: new Date(row.created_at) };
  }

  async listTables(
    projectId: string,
  ): Promise<{ name: string; columnCount: number; rowCount: number; createdAt: Date }[]> {
    const rows = await this.sql<Array<{ table_name: string; columns: ColumnDefinition[]; created_at: Date }>>`
      SELECT table_name, columns, created_at FROM carbon_tables WHERE project_id = ${projectId} ORDER BY table_name
    `;
    const schema = projectSchema(projectId);
    const out: { name: string; columnCount: number; rowCount: number; createdAt: Date }[] = [];
    for (const r of rows) {
      const countRows = await this.sql.unsafe<Array<{ count: string }>>(
        `SELECT COUNT(*)::text AS count FROM "${schema}".${quoteIdent(r.table_name, "table name")}`,
      );
      out.push({
        name: r.table_name,
        columnCount: r.columns.length,
        rowCount: Number(countRows[0]?.count ?? 0),
        createdAt: new Date(r.created_at),
      });
    }
    return out;
  }

  async dropTable(projectId: string, tableName: string): Promise<boolean> {
    const existing = await this.getTable(projectId, tableName);
    if (!existing) return false;
    const schema = projectSchema(projectId);
    await this.sql.unsafe(`DROP TABLE IF EXISTS "${schema}".${quoteIdent(tableName, "table name")}`);
    await this.sql`DELETE FROM carbon_tables WHERE project_id = ${projectId} AND table_name = ${tableName}`;
    return true;
  }

  private pkColumn(meta: TableMeta): ColumnDefinition {
    return meta.columns.find((c) => c.primaryKey) ?? meta.columns[0]!;
  }

  async insertRow(
    projectId: string,
    tableName: string,
    data: Record<string, unknown>,
    rlsContext?: RlsContext,
  ): Promise<Record<string, unknown>> {
    const meta = await this.getTable(projectId, tableName);
    if (!meta) throw new Error(`Table "${tableName}" not found`);

    const row: Record<string, unknown> = { ...data };
    const pkCol = this.pkColumn(meta);
    if (row[pkCol.name] === undefined || row[pkCol.name] === null) {
      row[pkCol.name] = `row_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    }

    for (const col of meta.columns) {
      if (row[col.name] === undefined) {
        if (col.type === "timestamp") row[col.name] = new Date().toISOString();
        else if (col.defaultValue !== undefined) row[col.name] = col.defaultValue;
        else row[col.name] = null;
      }
      // NO JSON.stringify for "json"-type columns: the raw JS value is
      // passed straight through in the `values` array below, to a real
      // jsonb column. Bun.SQL's own driver already knows (from preparing
      // this INSERT against the target table) that this bind parameter
      // is jsonb, and encodes the JS value accordingly — pre-stringifying
      // here double-encodes it into a jsonb STRING SCALAR holding
      // escaped JSON text, instead of the real jsonb object/array.
      // Verified directly against a real running Postgres
      // (`jsonb_typeof` reported "string" instead of "object" for a JS
      // object value before this fix) — same class of bug as
      // createTable's `columns` column, just in the OTHER code path
      // (positional `.unsafe(query, values)`, not a tagged template) —
      // Bun.SQL's jsonb-awareness applies to both, not only templates.
    }

    if (rlsContext && !this.rls.canInsert(projectId, tableName, rlsContext, row)) {
      throw new Error(`RLS violation: new row violates row-level security policy for table "${tableName}"`);
    }

    const schema = projectSchema(projectId);
    const cols = meta.columns.map((c) => c.name);
    const colIdents = cols.map((c) => quoteIdent(c, "column name")).join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const values = cols.map((c) => row[c]);

    let inserted: Record<string, unknown>;
    try {
      const result = await this.sql.unsafe<Record<string, unknown>[]>(
        `INSERT INTO "${schema}".${quoteIdent(tableName, "table name")} (${colIdents}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      inserted = result[0]!;
    } catch (err) {
      if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
        throw new Error(`Primary key conflict: value "${row[pkCol.name]}" already exists`);
      }
      throw err;
    }

    this.realtime.notifyDatabaseChange(projectId, tableName, "INSERT", inserted, null);
    return inserted;
  }

  private buildWhere(filter: Record<string, unknown> | undefined, startAt = 1): { clause: string; values: unknown[] } {
    const entries = Object.entries(filter ?? {});
    if (entries.length === 0) return { clause: "TRUE", values: [] };
    const parts: string[] = [];
    const values: unknown[] = [];
    entries.forEach(([col, val], i) => {
      parts.push(`${quoteIdent(col, "column name")} = $${startAt + i}`);
      values.push(val);
    });
    return { clause: parts.join(" AND "), values };
  }

  async queryRows(
    projectId: string,
    tableName: string,
    options: QueryOptions = {},
    rlsContext?: RlsContext,
  ): Promise<QueryResult> {
    const meta = await this.getTable(projectId, tableName);
    if (!meta) throw new Error(`Table "${tableName}" not found`);
    const schema = projectSchema(projectId);
    const tableIdent = quoteIdent(tableName, "table name");

    const where = this.buildWhere(options.filter);
    let query = `SELECT * FROM "${schema}".${tableIdent} WHERE ${where.clause}`;
    if (options.orderBy) {
      query += ` ORDER BY ${quoteIdent(options.orderBy, "column name")} ${options.orderDirection === "desc" ? "DESC" : "ASC"}`;
    }

    const allMatching = await this.sql.unsafe<Record<string, unknown>[]>(query, where.values);
    const total = allMatching.length;

    let rows = allMatching;
    if (rlsContext) {
      rows = rows.filter((r) => this.rls.canSelect(projectId, tableName, rlsContext, r));
    }
    const total2 = rlsContext ? rows.length : total;

    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return { rows: rows.slice(offset, offset + limit), total: total2 };
  }

  async updateRows(
    projectId: string,
    tableName: string,
    filter: Record<string, unknown>,
    updates: Record<string, unknown>,
    rlsContext?: RlsContext,
  ): Promise<number> {
    const meta = await this.getTable(projectId, tableName);
    if (!meta) throw new Error(`Table "${tableName}" not found`);
    const pkCol = this.pkColumn(meta);
    const schema = projectSchema(projectId);
    const tableIdent = quoteIdent(tableName, "table name");
    const pkIdent = quoteIdent(pkCol.name, "column name");

    return await this.sql.begin(async (tx) => {
      const where = this.buildWhere(filter);
      const matching = await tx.unsafe<Record<string, unknown>[]>(
        `SELECT * FROM "${schema}".${tableIdent} WHERE ${where.clause} FOR UPDATE`,
        where.values,
      );

      const updateCols = Object.keys(updates);
      let count = 0;
      for (const oldRow of matching) {
        if (rlsContext && !this.rls.canUpdate(projectId, tableName, rlsContext, oldRow)) continue;
        if (updateCols.length === 0) continue;

        const setClause = updateCols.map((c, i) => `${quoteIdent(c, "column name")} = $${i + 1}`).join(", ");
        const values = updateCols.map((c) => updates[c]);
        const pkValue = oldRow[pkCol.name];
        const newRows = await tx.unsafe<Record<string, unknown>[]>(
          `UPDATE "${schema}".${tableIdent} SET ${setClause} WHERE ${pkIdent} = $${updateCols.length + 1} RETURNING *`,
          [...values, pkValue],
        );
        count++;
        this.realtime.notifyDatabaseChange(projectId, tableName, "UPDATE", newRows[0] ?? null, oldRow);
      }
      return count;
    });
  }

  async deleteRows(
    projectId: string,
    tableName: string,
    filter: Record<string, unknown>,
    rlsContext?: RlsContext,
  ): Promise<number> {
    const meta = await this.getTable(projectId, tableName);
    if (!meta) throw new Error(`Table "${tableName}" not found`);
    const pkCol = this.pkColumn(meta);
    const schema = projectSchema(projectId);
    const tableIdent = quoteIdent(tableName, "table name");
    const pkIdent = quoteIdent(pkCol.name, "column name");

    return await this.sql.begin(async (tx) => {
      const where = this.buildWhere(filter);
      const matching = await tx.unsafe<Record<string, unknown>[]>(
        `SELECT * FROM "${schema}".${tableIdent} WHERE ${where.clause} FOR UPDATE`,
        where.values,
      );

      let count = 0;
      for (const oldRow of matching) {
        if (rlsContext && !this.rls.canDelete(projectId, tableName, rlsContext, oldRow)) continue;
        await tx.unsafe(`DELETE FROM "${schema}".${tableIdent} WHERE ${pkIdent} = $1`, [oldRow[pkCol.name]]);
        count++;
        this.realtime.notifyDatabaseChange(projectId, tableName, "DELETE", null, oldRow);
      }
      return count;
    });
  }

  /**
   * Runs real SQL against the project's own schema — no regex parsing, no
   * simulated command subset. `search_path` is set for this connection's
   * session only (a fresh session per call via a transaction, so it can't
   * leak into a pooled connection reused by a different project) and
   * restricted to that project's schema, so an app's own SQL naturally
   * addresses its own tables by bare name (`SELECT * FROM users`) the way
   * a real single-tenant Postgres database would.
   */
  async executeRawSql(projectId: string, rawSql: string): Promise<RawSqlResult> {
    const schema = await this.ensureSchema(projectId);
    const start = performance.now();
    const trimmed = rawSql.trim().replace(/;+$/, "");
    const upperFirstWord = trimmed.split(/\s+/)[0]?.toUpperCase() ?? "";

    const result = await this.sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
      return await tx.unsafe<Record<string, unknown>[]>(trimmed);
    });

    const columns = result.length > 0 ? Object.keys(result[0]!) : [];
    return {
      columns,
      rows: result,
      rowCount: result.length,
      command: upperFirstWord,
      executionTimeMs: performance.now() - start,
    };
  }
}
