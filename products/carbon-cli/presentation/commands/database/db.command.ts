// `carbon db` — command-line interface for interacting with local or remote
// Carbon Database services: health check, SQL execution, and snapshot exports.

import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
import { log, c } from "@carbon/logging";
import { readFileSync } from "node:fs";
import { parseComponent } from "@carbon/contracts/platform";
import { DatabaseDeviceClient } from "../../../infrastructure/cloud/DatabaseDeviceClient.ts";
import { DeviceCredentialStore } from "../../../infrastructure/cloud/DeviceCredentialStore.ts";

export interface DbCommandOptions {
  url?: string;
  token?: string;
  project?: string;
}

export interface DbCommandDependencies {
  readonly deviceStore: DeviceCredentialStore;
  readonly databaseClient: DatabaseDeviceClient;
}

function defaultDependencies(): DbCommandDependencies {
  return { deviceStore: new DeviceCredentialStore(), databaseClient: new DatabaseDeviceClient() };
}

export async function dbCommand(rest: string[], dependencies: DbCommandDependencies = defaultDependencies()): Promise<number> {
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
      case "data":
        return await dbData(url, args, dependencies);
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

async function dbData(defaultUrl: string, args: string[], dependencies: DbCommandDependencies): Promise<number> {
  let databaseUrl = defaultUrl; let bindingId = ""; let commandText = ""; let commandFile = "";
  for (let i = 0; i < args.length; i += 1) {
    const next = args[i + 1];
    if (args[i] === "--database-url" && next) { databaseUrl = next; i++; }
    else if (args[i] === "--binding" && next) { bindingId = next; i++; }
    else if (args[i] === "--command" && next) { commandText = next; i++; }
    else if (args[i] === "--command-file" && next) { commandFile = next; i++; }
    else { log.error(`unknown or incomplete data option: ${args[i]}`); return 1; }
  }
  if (!bindingId || (!commandText && !commandFile) || (commandText && commandFile)) {
    log.error("data requires --binding and exactly one of --command or --command-file");
    return 1;
  }
  const active = await dependencies.deviceStore.active();
  if (!active) { log.error("no active device login — run `carbon cloud login` first"); return 1; }
  const scope = parseComponent("EnvironmentScope", active.profile.grant.scope);
  let value: unknown;
  try { value = JSON.parse(commandFile ? readFileSync(commandFile, "utf8") : commandText); }
  catch { log.error("data command must be valid JSON"); return 1; }
  const request = parseComponent("DataRequest", { scope, bindingId, command: value });
  const result = await dependencies.databaseClient.execute(databaseUrl, active.profile, active.token, request);
  log.raw(JSON.stringify(result, null, 2) + "\n");
  return 0;
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
  ${c.cyan("data")}           Execute one canonical platform data command using device authorization
    --database-url <origin>  Database service origin (or CARBON_DB_URL)
    --binding <id>           Exact Database binding ID
    --command <json>         Data command JSON
    --command-file <path>    Read data command JSON from a file

${c.bold("Examples:")}
  ${c.dim("$")} carbon db status
  ${c.dim("$")} carbon db sql "SELECT * FROM users LIMIT 5;"
  ${c.dim("$")} carbon db export backup.json
  ${c.dim("$")} carbon db data --database-url https://database.example.com --binding <id> --command '{"kind":"tables.list"}'
`);
}

export class DbCommand extends Command {
  readonly meta: CommandMeta = {
    name: "db",
    summary: "Inspect and query local Carbon Database services",
    usage: "db <status|sql|export|data> [options]",
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
