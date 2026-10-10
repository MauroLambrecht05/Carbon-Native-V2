import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function openDatabase(url: string): Bun.SQL {
  return new Bun.SQL(url);
}

/** Product-owned checksummed migration ledger. Legacy idempotent migrations
 * are adopted without changing existing records; deployers serialize on a
 * transaction advisory lock and reject missing, changed or backdated history. */
export async function migrate(sql: Bun.SQL, dir: string = join(import.meta.dir, "migrations")): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (files.some(file => !/^\d{4}_[a-z0-9_]+\.sql$/.test(file)) || new Set(files.map(file => file.slice(0, 4))).size !== files.length) {
    throw new Error("Migration names must have unique ordered four-digit versions");
  }
  const migrations = files.map(file => {
    // Line-ending normalization makes checksums portable between Git checkouts.
    const statement = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n");
    return { file, statement, checksum: createHash("sha256").update(statement).digest("hex") };
  });
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(1128354370, 3)`;
    await tx`CREATE TABLE IF NOT EXISTS registry_schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const applied = await tx<{ version: string; checksum: string }[]>`SELECT version, checksum FROM registry_schema_migrations ORDER BY version`;
    // Validate the whole history before running even one new statement.
    for (let index = 0; index < applied.length; index++) {
      const existing = applied[index]!;
      const source = migrations[index];
      if (!source || source.file !== existing.version || source.checksum !== existing.checksum) {
        throw new Error(`carbon-registry migration history drift at ${existing.version}`);
      }
    }
    for (const migration of migrations.slice(applied.length)) {
      await tx.unsafe(migration.statement);
      await tx`INSERT INTO registry_schema_migrations (version, checksum) VALUES (${migration.file}, ${migration.checksum})`;
    }
  });
}
