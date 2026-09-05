// The product's own Postgres connection. Same shape as carbon-database's
// Database.ts — copied, not shared, since each hosted product owns its
// own persistence and there's no cross-product Postgres dependency
// (unlike identity, which this product calls carbon-cloud's real API for
// instead of keeping a second copy — see HttpIdentityClient).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function openDatabase(url: string): Bun.SQL {
  return new Bun.SQL(url);
}

/**
 * Applies every migrations/*.sql file, in filename order, inside one
 * transaction per file. Each file is written `CREATE ... IF NOT EXISTS`,
 * so re-running the set is a no-op.
 */
export async function migrate(sql: Bun.SQL, dir: string = join(import.meta.dir, "migrations")): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const statement = readFileSync(join(dir, file), "utf8");
    await sql.unsafe(statement);
  }
}
