// `carbon db` — command-line interface for interacting with local or remote
// Carbon Database services: health check, SQL execution, and snapshot exports.

import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
import { log, c } from "@carbon/logging";

export interface DbCommandOptions {
  url?: string;
  token?: string;
  project?: string;
}

export async function dbCommand(rest: string[]): Promise<number> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    printDbHelp();
    return 0;
  }

  const subcommand = rest[0];
  const args = rest.slice(1);

  const url = process.env.CARBON_DB_URL || "http://localhost:54321";
  const token = process.env.CARBON_DB_TOKEN || "";
  const project = process.env.CARBON_DB_PROJECT || "default";

  try {
    switch (subcommand) {
      case "status":
        return await dbStatus(url);
      case "sql":
        return await dbSql(url, token, project, args);
      case "export":
        return await dbExport(url, token, project, args);
      default:
        log.error(`unknown subcommand "${subcommand}"`);
        printDbHelp();
        return 1;
    }
  } catch (err: any) {
    log.error(`db error: ${err.message || String(err)}`);
    return 1;
  }
}

async function dbStatus(url: string): Promise<number> {
  const start = performance.now();
  try {
    const res = await fetch(`${url}/api/health`);
    if (!res.ok) {
      log.error(`Database offline or unhealthy (HTTP ${res.status})`);
      return 1;
    }

    const data = (await res.json()) as any;
    const latency = Math.round(performance.now() - start);

    log.raw(`
${c.bold(c.green("● Carbon Database Online"))}
  ${c.dim("Endpoint:")} ${url}
  ${c.dim("Version:")}  ${data.version || "0.1.0"}
  ${c.dim("Latency:")}  ${latency}ms
  ${c.dim("Engines:")}  ${(data.engines || []).join(", ")}
`);
    return 0;
  } catch (err: any) {
    log.error(`Could not connect to Carbon Database at ${url}: ${err.message}`);
    log.raw(c.dim("Start the local service using: bun run products/carbon-database/main.ts\n"));
    return 1;
  }
}

async function dbSql(url: string, token: string, project: string, args: string[]): Promise<number> {
  const query = args.join(" ").trim();
  if (!query) {
    log.error("Please provide a SQL query. Example: carbon db sql \"SELECT * FROM users;\"");
    return 1;
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${url}/api/projects/${project}/sql`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    log.error(`SQL execution failed: ${err.error || res.statusText}`);
    return 1;
  }

  const result = (await res.json()) as any;
  log.raw(`${c.cyan(result.command)} ${c.dim(`(${result.rowCount} rows in ${result.executionTimeMs.toFixed(1)}ms)`)}`);

  if (result.rows && result.rows.length > 0) {
    console.table(result.rows);
  } else {
    log.raw(c.dim("Query returned 0 rows.\n"));
  }

  return 0;
}

async function dbExport(url: string, token: string, project: string, args: string[]): Promise<number> {
  const outPath = args[0] || "database_backup.json";
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${url}/api/projects/${project}/export`, { headers });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    log.error(`Export failed: ${err.error || res.statusText}`);
    return 1;
  }

  const snapshot = await res.text();
  await Bun.write(outPath, snapshot);

  log.success(`Database project "${project}" exported to ${c.bold(outPath)}`);
  return 0;
}

function printDbHelp(): void {
  log.raw(`
${c.bold("Usage:")} carbon db <subcommand> [options]

${c.bold("Subcommands:")}
  ${c.cyan("status")}         Check database server connectivity and engine health
  ${c.cyan("sql <query>")}    Execute a SQL statement and display the results table
  ${c.cyan("export [file]")}  Export all tables, vectors, and graph state to JSON

${c.bold("Examples:")}
  ${c.dim("$")} carbon db status
  ${c.dim("$")} carbon db sql "SELECT * FROM users LIMIT 5;"
  ${c.dim("$")} carbon db export backup.json
`);
}

export class DbCommand extends Command {
  readonly meta: CommandMeta = {
    name: "db",
    summary: "Inspect and query local Carbon Database services",
    usage: "db <status|sql|export> [options]",
    examples: [
      "carbon db status",
      "carbon db sql \"SELECT * FROM users;\"",
      "carbon db export backup.json",
    ],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return dbCommand([...ctx.argv]);
  }
}

export default DbCommand;
