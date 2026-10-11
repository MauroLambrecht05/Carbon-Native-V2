import { join } from "node:path";
import { allowNewerSchema, Metrics, migrationStatus, observe, prepareSchema, schemaServable, operationsRoutes, type OperationsConfig, type Sample } from "@carbon/operations";

const LEDGER = "cloud_schema_migrations";
const MIGRATIONS = join(import.meta.dir, "../infrastructure/persistence/migrations");

/** Applies this service's migrations at start, or with `CARBON_MIGRATE_ON_START=disabled` refuses to start on a schema it may not serve. */
export const prepareServiceSchema = (sql: Bun.SQL, migrate: (sql: Bun.SQL) => Promise<unknown>, env: NodeJS.ProcessEnv = process.env) =>
  prepareSchema({ sql, ledger: LEDGER, directory: MIGRATIONS, migrate: () => migrate(sql), env });

type Row = { name: string; label: string | null; value: string | number | null };
const HELP: Record<string, string> = {
  "carbon_operations_open": "Provisioning operations not yet finished, by state.",
  "carbon_operations_oldest_seconds": "Age of the oldest unfinished provisioning operation.",
  "carbon_worker_leases_open": "Worker leases granted or claimed, by state.",
  "carbon_worker_leases_overdue": "Open worker leases past their expiry that the sweeper has not yet handled.",
  "carbon_builds_open": "Builds queued or running, by state.",
  "carbon_builds_oldest_queued_seconds": "Age of the oldest queued build.",
  "carbon_function_executions_open": "Function executions queued or running, by state.",
  "carbon_function_executions_oldest_queued_seconds": "Age of the oldest queued function execution.",
  "carbon_email_outbox_pending": "Emails waiting to be sent.",
  "carbon_email_outbox_oldest_seconds": "Age of the oldest email waiting to be sent.",
  "carbon_data_jobs_open": "Import and export jobs queued or running, by kind.",
  "carbon_billing_events_unmatched": "Provider events accepted but not tied to an organization.",
  "carbon_billing_last_event_seconds": "Time since the last provider event was received.",
  "carbon_deletions_blocked": "Organizations whose deletion window has passed but which a hold or a subscription keeps pending.",
  "carbon_operator_approvals_pending": "Operator requests waiting for a second operator."
};

/** Queue depths and ages, read in one statement when metrics are scraped. Counts and seconds only: nothing here is a customer's. */
export async function gauges(sql: Bun.SQL): Promise<Sample[]> {
  const rows = await sql.unsafe(`
    SELECT 'carbon_operations_open' AS name, state AS label, count(*)::bigint AS value FROM operations WHERE state IN ('queued', 'running', 'cancel_requested') GROUP BY state
    UNION ALL SELECT 'carbon_operations_oldest_seconds', NULL, extract(epoch FROM (now() - min(created_at)))::bigint FROM operations WHERE state IN ('queued', 'running', 'cancel_requested')
    UNION ALL SELECT 'carbon_worker_leases_open', state, count(*)::bigint FROM worker_leases WHERE state IN ('granted', 'claimed') GROUP BY state
    UNION ALL SELECT 'carbon_worker_leases_overdue', NULL, count(*)::bigint FROM worker_leases WHERE state IN ('granted', 'claimed') AND expires_at <= now()
    UNION ALL SELECT 'carbon_builds_open', state, count(*)::bigint FROM platform_builds WHERE state IN ('queued', 'running') GROUP BY state
    UNION ALL SELECT 'carbon_builds_oldest_queued_seconds', NULL, extract(epoch FROM (now() - min(created_at)))::bigint FROM platform_builds WHERE state = 'queued'
    UNION ALL SELECT 'carbon_function_executions_open', state, count(*)::bigint FROM function_executions WHERE state IN ('queued', 'running') GROUP BY state
    UNION ALL SELECT 'carbon_function_executions_oldest_queued_seconds', NULL, extract(epoch FROM (now() - min(created_at)))::bigint FROM function_executions WHERE state = 'queued'
    UNION ALL SELECT 'carbon_email_outbox_pending', NULL, (SELECT count(*) FROM account_email_outbox WHERE state IN ('pending', 'sending')) + (SELECT count(*) FROM app_email_outbox WHERE state IN ('pending', 'sending'))
    UNION ALL SELECT 'carbon_email_outbox_oldest_seconds', NULL, extract(epoch FROM (now() - min(ready_at)))::bigint FROM account_email_outbox WHERE state IN ('pending', 'sending')
    UNION ALL SELECT 'carbon_data_jobs_open', 'import', count(*)::bigint FROM data_import_jobs WHERE state IN ('queued', 'running', 'cancel_requested')
    UNION ALL SELECT 'carbon_data_jobs_open', 'export', count(*)::bigint FROM data_export_jobs WHERE state IN ('queued', 'running')
    UNION ALL SELECT 'carbon_billing_events_unmatched', NULL, count(*)::bigint FROM billing_webhook_events WHERE outcome = 'unmatched'
    UNION ALL SELECT 'carbon_billing_last_event_seconds', NULL, extract(epoch FROM (now() - max(received_at)))::bigint FROM billing_webhook_events
    UNION ALL SELECT 'carbon_deletions_blocked', NULL, count(*)::bigint FROM organizations o WHERE o.state = 'deletion_pending' AND o.deletion_scheduled_at <= now()
      AND (EXISTS (SELECT 1 FROM legal_holds h WHERE h.org_id = o.id AND h.released_at IS NULL) OR EXISTS (SELECT 1 FROM billing_subscriptions s WHERE s.org_id = o.id AND s.state IN ('active', 'past_due', 'cancel_scheduled')))
    UNION ALL SELECT 'carbon_operator_approvals_pending', NULL, count(*)::bigint FROM operator_approvals WHERE state = 'pending' AND expires_at > now()
  `) as Row[];
  return rows.filter(row => row.value !== null).map(row => ({ name: row.name, help: HELP[row.name] ?? row.name, type: "gauge" as const, ...(row.label ? { labels: { state: row.label } } : {}), value: Number(row.value) }));
}

/**
 * Readiness, metrics and request logging for Carbon Cloud. Ready means the database answers and holds exactly the
 * schema this code was written for; a deployment that has not run its migrations is not ready, and neither is one
 * running older code against a newer schema.
 */
export function composeOperations(sql: Bun.SQL, env: NodeJS.ProcessEnv = process.env, extraChecks: OperationsConfig["checks"] = {}) {
  const config: OperationsConfig = {
    service: "carbon-cloud", metrics: new Metrics(), metricsToken: env.CARBON_METRICS_TOKEN || undefined, collect: [() => gauges(sql)],
    checks: {
      database: async () => { await sql`SELECT 1`; },
      migrations: async () => { if (!schemaServable(await migrationStatus(sql, LEDGER, MIGRATIONS), allowNewerSchema(env))) throw new Error("schema is not servable"); },
      ...extraChecks,
    },
  };
  return { config, routes: operationsRoutes(config), observe: <Rest extends unknown[]>(handler: (request: Request, ...rest: Rest) => Response | Promise<Response>) => observe(config, handler) };
}
