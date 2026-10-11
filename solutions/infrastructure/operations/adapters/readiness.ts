// Whether a service can do its work. Every check reads; none of them changes
// anything, so a readiness probe can run as often as an orchestrator likes.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export type ReadinessCheck = () => Promise<void>;

/**
 * Runs every check with a time limit and reports which passed. The answer names the checks and nothing else: no
 * error text, no address, no version, because whoever can reach a probe is not necessarily an operator.
 */
export async function readiness(checks: Readonly<Record<string, ReadinessCheck>>, timeoutMs = 3000): Promise<{ ready: boolean; checks: Record<string, "ok" | "failed"> }> {
  const results = await Promise.all(Object.entries(checks).map(async ([name, check]): Promise<[string, "ok" | "failed"]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([check(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })]); return [name, "ok"]; }
    catch { return [name, "failed"]; }
    finally { if (timer) clearTimeout(timer); }
  }));
  return { ready: results.every(([, state]) => state === "ok"), checks: Object.fromEntries(results) };
}

export interface MigrationStatus {
  /** Versions in the database's ledger, in order. */
  readonly applied: readonly string[];
  /** Versions this code ships that the database does not have yet. */
  readonly pending: readonly string[];
  /** The first applied version that this code does not ship, or ships with different content. */
  readonly drift: string | null;
  /** True when the database is exactly at the version this code was written for. */
  readonly current: boolean;
}

/**
 * Compares a service's migration ledger with the migrations this code ships, without running or recording
 * anything. `ledger` is the service's own table (`cloud_schema_migrations` and so on).
 *
 * A database behind this code has `pending` entries; one ahead of it, or changed by hand, has `drift`.
 */
export async function migrationStatus(sql: Bun.SQL, ledger: string, directory: string): Promise<MigrationStatus> {
  if (!/^[a-z_]{1,63}$/.test(ledger)) throw new Error("Invalid migration ledger name");
  const shipped = readdirSync(directory).filter(file => file.endsWith(".sql")).sort().map(file => ({ file, checksum: createHash("sha256").update(readFileSync(`${directory}/${file}`, "utf8").replace(/\r\n/g, "\n")).digest("hex") }));
  const exists = (await sql`SELECT to_regclass(${`public.${ledger}`}) IS NOT NULL AS present`)[0].present as boolean;
  const applied = exists ? await sql.unsafe(`SELECT version, checksum FROM ${ledger} ORDER BY version`) as { version: string; checksum: string }[] : [];
  let drift: string | null = null;
  for (let index = 0; index < applied.length && drift === null; index++) {
    const source = shipped[index]; const row = applied[index]!;
    if (!source || source.file !== row.version || source.checksum !== row.checksum) drift = row.version;
  }
  const pending = drift === null ? shipped.slice(applied.length).map(item => item.file) : [];
  return { applied: applied.map(row => row.version), pending, drift, current: drift === null && pending.length === 0 };
}
