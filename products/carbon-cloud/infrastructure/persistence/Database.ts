// The product's own Postgres connection. What solutions/capabilities repos
// (PostgresBuildRepository, and whatever identity/billing add later) are
// handed — they know the `builds`/`accounts`/etc. tables, not how to
// connect.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function openDatabase(url: string): Bun.SQL {
  return new Bun.SQL(url);
}

/**
 * Applies every migrations/*.sql file, in filename order, inside one
 * transaction. No migration-tracking table yet — each file is written
 * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` so re-running
 * the set is a no-op, which is enough at one migration file. Revisit once
 * there's a second one that isn't purely additive.
 */
export async function migrate(sql: Bun.SQL, dir: string = join(import.meta.dir, "migrations")): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const statement = readFileSync(join(dir, file), "utf8");
    await sql.unsafe(statement);
  }
}
