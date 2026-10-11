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
  /** The first applied version that differs from what this code ships at the same position. */
  readonly drift: string | null;
  /** Versions applied after everything this code ships: the database belongs to a newer release. */
  readonly ahead: readonly string[];
  /** True when the database is exactly at the version this code was written for. */
  readonly current: boolean;
}

/**
 * Compares a service's migration ledger with the migrations this code ships, without running or recording
 * anything. `ledger` is the service's own table (`cloud_schema_migrations` and so on).
 *
 * A database behind this code has `pending` entries, one from a newer release has `ahead` entries, and one whose
 * history differs from this code's has `drift`.
 */
export async function migrationStatus(sql: Bun.SQL, ledger: string, directory: string): Promise<MigrationStatus> {
  if (!/^[a-z_]{1,63}$/.test(ledger)) throw new Error("Invalid migration ledger name");
  const shipped = readdirSync(directory).filter(file => file.endsWith(".sql")).sort().map(file => ({ file, checksum: createHash("sha256").update(readFileSync(`${directory}/${file}`, "utf8").replace(/\r\n/g, "\n")).digest("hex") }));
  const exists = (await sql`SELECT to_regclass(${`public.${ledger}`}) IS NOT NULL AS present`)[0].present as boolean;
  const applied = exists ? await sql.unsafe(`SELECT version, checksum FROM ${ledger} ORDER BY version`) as { version: string; checksum: string }[] : [];
  let drift: string | null = null;
  for (let index = 0; index < applied.length && drift === null; index++) {
    const source = shipped[index]; const row = applied[index]!;
    if (!source) break;
    if (source.file !== row.version || source.checksum !== row.checksum) drift = row.version;
  }
  const pending = drift === null ? shipped.slice(applied.length).map(item => item.file) : [];
  const ahead = drift === null ? applied.slice(shipped.length).map(row => row.version) : [];
  return { applied: applied.map(row => row.version), pending, drift, ahead, current: drift === null && pending.length === 0 && ahead.length === 0 };
}

/**
 * Whether this code may serve the schema it found.
 *
 * Normally only its own schema will do. `allowNewer` is the rollback setting: it also accepts a database that has
 * everything this code ships, unchanged, plus migrations from a newer release. That is safe only because
 * migrations are additive; it never accepts a database that is behind, or one whose history differs.
 */
export function schemaServable(status: MigrationStatus, allowNewer: boolean): boolean {
  return status.current || (allowNewer && status.drift === null && status.pending.length === 0);
}

/** Reads the rollback setting. Anything but the two words is a configuration error, not a default. */
export function allowNewerSchema(env: NodeJS.ProcessEnv): boolean {
  const value = env.CARBON_NEWER_SCHEMA;
  if (value === undefined || value === "" || value === "refused") return false;
  if (value === "allowed") return true;
  throw new Error("CARBON_NEWER_SCHEMA must be allowed or refused");
}

/**
 * What a service does about its schema when it starts. By default it applies its own migrations. With
 * `CARBON_MIGRATE_ON_START=disabled` it applies nothing and refuses to start on a schema it may not serve, saying
 * what it found, so that a deployment which forgot its migration step fails at once and visibly.
 */
export async function prepareSchema(options: { sql: Bun.SQL; ledger: string; directory: string; migrate: () => Promise<unknown>; env: NodeJS.ProcessEnv }): Promise<void> {
  const setting = options.env.CARBON_MIGRATE_ON_START;
  if (setting !== undefined && setting !== "" && setting !== "enabled" && setting !== "disabled") throw new Error("CARBON_MIGRATE_ON_START must be enabled or disabled");
  const allowNewer = allowNewerSchema(options.env);
  if (setting !== "disabled") {
    if (allowNewer) throw new Error("CARBON_NEWER_SCHEMA=allowed requires CARBON_MIGRATE_ON_START=disabled");
    await options.migrate(); return;
  }
  const status = await migrationStatus(options.sql, options.ledger, options.directory);
  if (schemaServable(status, allowNewer)) return;
  const found = status.drift !== null ? `its history differs at ${status.drift}` : status.pending.length ? `${status.pending.length} migration(s) are pending, from ${status.pending[0]}`
    : `it is ahead by ${status.ahead.length} migration(s), from ${status.ahead[0]}`;
  throw new Error(`The schema is not the one this version serves: ${found}. Run the migrate step, or see the rollback notes for CARBON_NEWER_SCHEMA.`);
}
