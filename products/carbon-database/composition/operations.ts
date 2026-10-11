import { join } from "node:path";
import { allowNewerSchema, Metrics, migrationStatus, observe, prepareSchema, schemaServable, operationsRoutes, type OperationsConfig, type Sample } from "@carbon/operations";

const LEDGER = "database_schema_migrations";
const MIGRATIONS = join(import.meta.dir, "../infrastructure/persistence/migrations");

/** Applies this service's migrations at start, or with `CARBON_MIGRATE_ON_START=disabled` refuses to start on a schema it may not serve. */
export const prepareServiceSchema = (sql: Bun.SQL, migrate: (sql: Bun.SQL) => Promise<unknown>, env: NodeJS.ProcessEnv = process.env) =>
  prepareSchema({ sql, ledger: LEDGER, directory: MIGRATIONS, migrate: () => migrate(sql), env });

type Row = { name: string; label: string | null; value: string | number | null };
const HELP: Record<string, string> = {
  "carbon_environments": "Environments this Database holds, by state.",
  "carbon_change_feed_events": "Change events retained in the feed.",
  "carbon_change_feed_oldest_seconds": "Age of the oldest retained change event.",
  "carbon_blob_transfers_open": "Blob transfers issued or in progress, by state.",
  "carbon_assertion_replays": "Assertion identifiers retained to refuse replays."
};

/** Queue depths and ages, read in one statement when metrics are scraped. Counts and seconds only: nothing here is a customer's. */
export async function gauges(sql: Bun.SQL): Promise<Sample[]> {
  const rows = await sql.unsafe(`
    SELECT 'carbon_environments' AS name, state AS label, count(*)::bigint AS value FROM platform_environments GROUP BY state
    UNION ALL SELECT 'carbon_change_feed_events', NULL, count(*)::bigint FROM data_change_events
    UNION ALL SELECT 'carbon_change_feed_oldest_seconds', NULL, extract(epoch FROM (now() - min(occurred_at)))::bigint FROM data_change_events
    UNION ALL SELECT 'carbon_blob_transfers_open', state, count(*)::bigint FROM blob_transfers WHERE state IN ('issued', 'receiving') GROUP BY state
    UNION ALL SELECT 'carbon_assertion_replays', NULL, count(*)::bigint FROM internal_assertion_replays
  `) as Row[];
  return rows.filter(row => row.value !== null).map(row => ({ name: row.name, help: HELP[row.name] ?? row.name, type: "gauge" as const, ...(row.label ? { labels: { state: row.label } } : {}), value: Number(row.value) }));
}

/**
 * Readiness, metrics and request logging for Carbon Database. Ready means the database answers and holds exactly the
 * schema this code was written for; a deployment that has not run its migrations is not ready, and neither is one
 * running older code against a newer schema.
 */
export function composeOperations(sql: Bun.SQL, env: NodeJS.ProcessEnv = process.env, extraChecks: OperationsConfig["checks"] = {}) {
  const config: OperationsConfig = {
    service: "carbon-database", metrics: new Metrics(), metricsToken: env.CARBON_METRICS_TOKEN || undefined, collect: [() => gauges(sql)],
    checks: {
      database: async () => { await sql`SELECT 1`; },
      migrations: async () => { if (!schemaServable(await migrationStatus(sql, LEDGER, MIGRATIONS), allowNewerSchema(env))) throw new Error("schema is not servable"); },
      ...extraChecks,
    },
  };
  return { config, routes: operationsRoutes(config), observe: <Rest extends unknown[]>(handler: (request: Request, ...rest: Rest) => Response | Promise<Response>) => observe(config, handler) };
}
