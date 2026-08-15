// `carbon cloud` — talk to a Carbon Cloud control plane: log in, trigger a
// build, check its status. The actual build/sign/package logic lives with
// the worker that claims the job (@carbon/cloud-workers); this command only
// creates the build and reports back what the API says.

import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
import { log, c } from "@carbon/logging";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { loadConfig } from "@carbon/workspace";

// Same directory signer.command.ts uses for keys — one place a user looks
// for anything `carbon` keeps on their machine.
const CREDENTIALS_PATH = join(homedir(), ".carbon", "cloud.json");

interface Credentials {
  readonly controlPlaneUrl: string;
  readonly apiToken: string;
}

function readCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null;
  return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as Credentials;
}

function writeCredentials(creds: Credentials): void {
  mkdirSync(join(homedir(), ".carbon"), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
  chmodSync(CREDENTIALS_PATH, 0o600);
}

export async function cloudCommand(rest: string[]): Promise<number> {
  if (rest.length === 0) {
    printCloudHelp();
    return 0;
  }

  const subcommand = rest[0];
  const args = rest.slice(1);

  try {
    switch (subcommand) {
      case "login":
        return await cloudLogin(args);
      case "deploy":
        return await cloudDeploy(args);
      case "status":
        return await cloudStatus(args);
      case "--help":
      case "-h":
      case "help":
        printCloudHelp();
        return 0;
      default:
        log.error(`unknown cloud subcommand: ${c.red(subcommand)}`);
        printCloudHelp();
        return 1;
    }
  } catch (e) {
    log.error(`carbon cloud failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function cloudLogin(args: string[]): Promise<number> {
  let controlPlaneUrl = "";
  let apiToken = "";
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--url" && i + 1 < args.length) {
      controlPlaneUrl = args[i + 1];
      i += 2;
    } else if (args[i] === "--token" && i + 1 < args.length) {
      apiToken = args[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  if (!controlPlaneUrl || !apiToken) {
    log.error("--url and --token are both required");
    return 1;
  }

  writeCredentials({ controlPlaneUrl: controlPlaneUrl.replace(/\/$/, ""), apiToken });
  log.success(`saved credentials for ${controlPlaneUrl} to ${CREDENTIALS_PATH}`);
  return 0;
}

async function cloudDeploy(args: string[]): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    log.error("not logged in — run `carbon cloud login --url <url> --token <token>` first");
    return 1;
  }

  let repoUrl = "";
  let commitSha = "";
  const targets: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--repo" && i + 1 < args.length) {
      repoUrl = args[i + 1];
      i += 2;
    } else if (args[i] === "--commit" && i + 1 < args.length) {
      commitSha = args[i + 1];
      i += 2;
    } else if (args[i] === "--target" && i + 1 < args.length) {
      targets.push(args[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }

  if (!repoUrl || !commitSha || targets.length === 0) {
    log.error("--repo, --commit and at least one --target are required");
    return 1;
  }

  // Loaded but only to confirm this runs inside a carbon project — the
  // control plane is what actually reads the repo's carbon.toml, on the
  // worker, after checkout.
  await loadConfig();

  const res = await fetch(`${creds.controlPlaneUrl}/v1/builds`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creds.apiToken}` },
    body: JSON.stringify({ repoUrl, commitSha, targets }),
  });
  if (!res.ok) {
    log.error(`control plane returned ${res.status}: ${await res.text()}`);
    return 1;
  }
  const build = (await res.json()) as { id: string; status: string };
  log.success(`build ${build.id} queued (${build.status})`);
  log.info(`carbon cloud status ${build.id}`);
  return 0;
}

async function cloudStatus(args: string[]): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    log.error("not logged in — run `carbon cloud login --url <url> --token <token>` first");
    return 1;
  }
  const buildId = args[0];
  if (!buildId) {
    log.error("build id required: carbon cloud status <build-id>");
    return 1;
  }

  const res = await fetch(`${creds.controlPlaneUrl}/v1/builds/${buildId}`, {
    headers: { authorization: `Bearer ${creds.apiToken}` },
  });
  if (!res.ok) {
    log.error(`control plane returned ${res.status}: ${await res.text()}`);
    return 1;
  }
  console.log(JSON.stringify(await res.json(), null, 2));
  return 0;
}

function printCloudHelp() {
  console.log(`
${c.bold("carbon cloud")} — build, sign and publish through Carbon Cloud

${c.bold("Usage:")}
  carbon cloud <subcommand> [options]

${c.bold("Subcommands:")}
  ${c.cyan("login")}    Save credentials for a control plane
               --url <url>                 (required)
               --token <token>             (required)

  ${c.cyan("deploy")}   Queue a build
               --repo <git-url>            (required)
               --commit <sha>              (required)
               --target <id>               (required, repeatable)

  ${c.cyan("status")}   Check a build's status
               <build-id>                  (required)

${c.bold("Examples:")}
  ${c.dim("$")} carbon cloud login --url https://cloud.example.com --token abc123
  ${c.dim("$")} carbon cloud deploy --repo https://github.com/me/app.git --commit HEAD --target deb
  ${c.dim("$")} carbon cloud status 9f2c...
`);
}

// ── Command ─────────────────────────────────────────────────────────────────

export class CloudCommand extends Command {
  readonly meta: CommandMeta = {
    name: "cloud",
    summary: "Build, sign and publish through Carbon Cloud",
    usage: "cloud <login|deploy|status> [options]",
    examples: [
      "carbon cloud login --url https://cloud.example.com --token abc123",
      "carbon cloud deploy --repo https://github.com/me/app.git --commit HEAD --target deb",
    ],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return cloudCommand([...ctx.argv]);
  }
}

export default CloudCommand;
