// `carbon cloud` — talk to a Carbon Cloud control plane: log in, trigger a
// build, check its status. The actual build/sign/package logic lives with
// the worker that claims the job (@carbon/worker); this command only
// creates the build and reports back what the API says.

import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
import { log, c } from "@carbon/logging";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { loadConfig } from "@carbon/workspace";
import { parseComponent, type Permission } from "@carbon/contracts/platform";
import { DeviceAuthorizationClient } from "../../../infrastructure/cloud/DeviceAuthorizationClient.ts";
import { DeviceCredentialStore } from "../../../infrastructure/cloud/DeviceCredentialStore.ts";

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

export interface CloudCommandDependencies {
  readonly deviceClient: DeviceAuthorizationClient;
  readonly deviceStore: DeviceCredentialStore;
}

function defaultDependencies(): CloudCommandDependencies {
  return { deviceClient: new DeviceAuthorizationClient(), deviceStore: new DeviceCredentialStore() };
}

export async function cloudCommand(rest: string[], dependencies: CloudCommandDependencies = defaultDependencies()): Promise<number> {
  if (rest.length === 0) {
    printCloudHelp();
    return 0;
  }

  const subcommand = rest[0];
  const args = rest.slice(1);

  try {
    switch (subcommand) {
      case "signup":
        return await cloudSignup(args);
      case "login":
        return await cloudLogin(args, dependencies);
      case "logout":
        return await cloudLogout(dependencies);
      case "worker-token":
        return await cloudWorkerToken();
      case "deploy":
        return await cloudDeploy(args);
      case "list":
        return await cloudList(args);
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

async function cloudSignup(args: string[]): Promise<number> {
  let controlPlaneUrl = "";
  let name = "";
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--url" && i + 1 < args.length) {
      controlPlaneUrl = args[i + 1];
      i += 2;
    } else if (args[i] === "--name" && i + 1 < args.length) {
      name = args[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  if (!controlPlaneUrl || !name) {
    log.error("--url and --name are both required");
    return 1;
  }

  const res = await fetch(`${controlPlaneUrl.replace(/\/$/, "")}/v1/orgs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    log.error(`control plane returned ${res.status}: ${await res.text()}`);
    return 1;
  }
  const { orgId, apiToken } = (await res.json()) as { orgId: string; apiToken: string };

  writeCredentials({ controlPlaneUrl: controlPlaneUrl.replace(/\/$/, ""), apiToken });
  log.success(`created org ${orgId}, saved credentials to ${CREDENTIALS_PATH}`);
  log.warn("this token is shown once — it's already saved, but back it up if you manage secrets separately");
  return 0;
}

async function cloudLogin(args: string[], dependencies: CloudCommandDependencies): Promise<number> {
  let controlPlaneUrl = "";
  let apiToken = "";
  let orgId = "";
  let projectId = "";
  let environmentId = "";
  const permissions: Permission[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--url" && i + 1 < args.length) {
      controlPlaneUrl = args[i + 1];
      i += 2;
    } else if (args[i] === "--token" && i + 1 < args.length) {
      apiToken = args[i + 1];
      i += 2;
    } else if (args[i] === "--org" && i + 1 < args.length) {
      orgId = args[i + 1]; i += 2;
    } else if (args[i] === "--project" && i + 1 < args.length) {
      projectId = args[i + 1]; i += 2;
    } else if (args[i] === "--environment" && i + 1 < args.length) {
      environmentId = args[i + 1]; i += 2;
    } else if (args[i] === "--permission" && i + 1 < args.length) {
      permissions.push(parseComponent("Permission", args[i + 1])); i += 2;
    } else {
      i++;
    }
  }

  if (!controlPlaneUrl) {
    log.error("--url is required");
    return 1;
  }
  if (apiToken) {
    if (orgId || projectId || environmentId || permissions.length) { log.error("--token cannot be combined with device scope options"); return 1; }
    writeCredentials({ controlPlaneUrl: controlPlaneUrl.replace(/\/$/, ""), apiToken });
    log.success(`saved legacy credentials for ${controlPlaneUrl} to ${CREDENTIALS_PATH}`);
    return 0;
  }
  if (!orgId || !projectId || !environmentId || !permissions.length) {
    log.error("device login requires --org, --project, --environment and at least one --permission");
    return 1;
  }
  const scope = parseComponent("EnvironmentScope", { orgId, projectId, environmentId });
  const result = await dependencies.deviceClient.authorize(controlPlaneUrl, {
    clientName: "Carbon CLI", deviceName: hostname().slice(0, 200) || "Unknown device", scope, permissions: [...new Set(permissions)].sort(),
  }, { challenge: challenge => {
    log.raw(`Open ${challenge.verificationUri}\nEnter code: ${challenge.userCode}\n`);
  } });
  await dependencies.deviceStore.save(controlPlaneUrl, result.token, result.grant);
  log.success(`authorized ${result.grant.clientName} for environment ${environmentId}`);
  return 0;
}

async function cloudLogout(dependencies: CloudCommandDependencies): Promise<number> {
  const device = await dependencies.deviceStore.clear();
  const legacy = existsSync(CREDENTIALS_PATH);
  if (legacy) rmSync(CREDENTIALS_PATH, { force: true });
  if (!device && !legacy) { log.info("no Carbon Cloud credentials were stored"); return 0; }
  log.success("removed local Carbon Cloud credentials");
  return 0;
}

async function cloudWorkerToken(): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    log.error("not logged in — run `carbon cloud login --url <url> --token <token>` first");
    return 1;
  }

  const res = await fetch(`${creds.controlPlaneUrl}/v1/worker-tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.apiToken}` },
  });
  if (!res.ok) {
    log.error(`control plane returned ${res.status}: ${await res.text()}`);
    return 1;
  }
  const { workerToken } = (await res.json()) as { workerToken: string };
  log.success(`worker token: ${workerToken}`);
  log.info("set WORKER_API_TOKEN to this for every worker (Linux/Windows/macOS) — not the org token above");
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

async function cloudList(args: string[]): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    log.error("not logged in — run `carbon cloud login --url <url> --token <token>` first");
    return 1;
  }

  let limit = 20;
  let i = 0;
  while (i < args.length) {
    if (args[i] === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      i += 2;
    } else {
      i++;
    }
  }

  const res = await fetch(`${creds.controlPlaneUrl}/v1/builds?limit=${limit}`, {
    headers: { authorization: `Bearer ${creds.apiToken}` },
  });
  if (!res.ok) {
    log.error(`control plane returned ${res.status}: ${await res.text()}`);
    return 1;
  }
  const builds = (await res.json()) as Array<{ id: string; status: string; commitSha: string; targets: string[] }>;
  if (builds.length === 0) {
    log.info("no builds yet");
    return 0;
  }
  for (const b of builds) {
    console.log(`${b.id}  ${b.status.padEnd(10)}  ${b.commitSha.slice(0, 8)}  ${b.targets.join(",")}`);
  }
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
  ${c.cyan("signup")}   Create an org and save its token (self-hosted v1: this is the whole signup flow)
               --url <url>                 (required)
               --name <org-name>           (required)

  ${c.cyan("login")}    Authorize this CLI through the browser device flow
               --url <url>                 (required)
               --org <organization-id>     (required)
               --project <project-id>      (required)
               --environment <env-id>      (required)
               --permission <permission>   (required, repeatable)
               --token <legacy-token>      (legacy compatibility; excludes scope options)

  ${c.cyan("logout")}   Remove the active device credential from OS secure storage

  ${c.cyan("worker-token")} Mint a worker-scoped token (set WORKER_API_TOKEN to it) — separate
               from the org token above: a worker token can claim/complete
               any org's queued work, an org token cannot

  ${c.cyan("deploy")}   Queue a build
               --repo <git-url>            (required)
               --commit <sha>              (required)
               --target <id>               (required, repeatable)

  ${c.cyan("list")}     List recent builds for your org
               --limit <n>                 (default: 20)

  ${c.cyan("status")}   Check a build's status
               <build-id>                  (required)

${c.bold("Examples:")}
  ${c.dim("$")} carbon cloud signup --url https://cloud.example.com --name "My Org"
  ${c.dim("$")} carbon cloud login --url https://cloud.example.com --org <id> --project <id> --environment <id> --permission metadata.read
  ${c.dim("$")} carbon cloud deploy --repo https://github.com/me/app.git --commit HEAD --target deb
  ${c.dim("$")} carbon cloud status 9f2c...
`);
}

// ── Command ─────────────────────────────────────────────────────────────────

export class CloudCommand extends Command {
  readonly meta: CommandMeta = {
    name: "cloud",
    summary: "Build, sign and publish through Carbon Cloud",
    usage: "cloud <signup|login|logout|worker-token|deploy|list|status> [options]",
    examples: [
      "carbon cloud signup --url https://cloud.example.com --name \"My Org\"",
      "carbon cloud deploy --repo https://github.com/me/app.git --commit HEAD --target deb",
    ],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return cloudCommand([...ctx.argv]);
  }
}

export default CloudCommand;
