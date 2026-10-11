import { join } from "node:path";
import { Metrics, migrationStatus, observe, operationsRoutes, type OperationsConfig, type Sample } from "@carbon/operations";

type Row = { name: string; label: string | null; value: string | number | null };
const HELP: Record<string, string> = {
  "carbon_environments": "Environments this Registry holds, by state.",
  "carbon_registry_versions": "Package versions, by state.",
  "carbon_registry_review_oldest_seconds": "Age of the oldest version waiting for review.",
  "carbon_registry_publishers": "Publisher names claimed.",
  "carbon_assertion_replays": "Assertion identifiers retained to refuse replays."
};

/** Queue depths and ages, read in one statement when metrics are scraped. Counts and seconds only: nothing here is a customer's. */
export async function gauges(sql: Bun.SQL): Promise<Sample[]> {
  const rows = await sql.unsafe(`
    SELECT 'carbon_environments' AS name, state AS label, count(*)::bigint AS value FROM platform_environments GROUP BY state
    UNION ALL SELECT 'carbon_registry_versions', state, count(*)::bigint FROM registry_versions GROUP BY state
    UNION ALL SELECT 'carbon_registry_review_oldest_seconds', NULL, extract(epoch FROM (now() - min(created_at)))::bigint FROM registry_versions WHERE state = 'submitted'
    UNION ALL SELECT 'carbon_registry_publishers', NULL, count(*)::bigint FROM registry_publishers
    UNION ALL SELECT 'carbon_assertion_replays', NULL, count(*)::bigint FROM internal_assertion_replays
  `) as Row[];
  return rows.filter(row => row.value !== null).map(row => ({ name: row.name, help: HELP[row.name] ?? row.name, type: "gauge" as const, ...(row.label ? { labels: { state: row.label } } : {}), value: Number(row.value) }));
}

/**
 * Readiness, metrics and request logging for Carbon Registry. Ready means the database answers and holds exactly the
 * schema this code was written for; a deployment that has not run its migrations is not ready, and neither is one
 * running older code against a newer schema.
 */
export function composeOperations(sql: Bun.SQL, env: NodeJS.ProcessEnv = process.env, extraChecks: OperationsConfig["checks"] = {}) {
  const config: OperationsConfig = {
    service: "carbon-registry", metrics: new Metrics(), metricsToken: env.CARBON_METRICS_TOKEN || undefined, collect: [() => gauges(sql)],
    checks: {
      database: async () => { await sql`SELECT 1`; },
      migrations: async () => { const status = await migrationStatus(sql, "registry_schema_migrations", join(import.meta.dir, "../infrastructure/persistence/migrations")); if (!status.current) throw new Error("schema is not current"); },
      ...extraChecks,
    },
  };
  return { config, routes: operationsRoutes(config), observe: <Rest extends unknown[]>(handler: (request: Request, ...rest: Rest) => Response | Promise<Response>) => observe(config, handler) };
}
