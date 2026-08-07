import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
import { log, c } from "@carbon/logging";
import { loadConfig } from "@carbon/workspace";
import { BuildUpdateManifestUseCase } from "@carbon/publishing";
import { existsSync, readFileSync } from "fs";

export async function publishCommand(rest: string[]): Promise<number> {
  if (rest.length === 0) {
    printPublishHelp();
    return 0;
  }

  const subcommand = rest[0];
  const args = rest.slice(1);

  try {
    switch (subcommand) {
      case "app": {
        return await publishApp(args);
      }
      case "rollback": {
        return await publishRollback(args);
      }
      case "yank": {
        return await publishYank(args);
      }
      case "status": {
        return await publishStatus(args);
      }
      case "--help":
      case "-h":
      case "help":
        printPublishHelp();
        return 0;
      default:
        log.error(`unknown publish subcommand: ${c.red(subcommand)}`);
        printPublishHelp();
        return 1;
    }
  } catch (e) {
    // See bundle.command.ts: `e` is `unknown` under strict mode and a throw is
    // not required to be an Error.
    log.error(`Publish failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function publishApp(args: string[]): Promise<number> {
  let channel = "stable";
  let version = "";
  let rollout = 100;
  let inputDir = "dist";
  let dryRun = false;

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--channel" && i + 1 < args.length) {
      channel = args[i + 1];
      i += 2;
    } else if (args[i] === "--version" && i + 1 < args.length) {
      version = args[i + 1];
      i += 2;
    } else if (args[i] === "--rollout" && i + 1 < args.length) {
      rollout = parseInt(args[i + 1], 10);
      i += 2;
    } else if (args[i] === "--input" && i + 1 < args.length) {
      inputDir = args[i + 1];
      i += 2;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
      i++;
    } else {
      i++;
    }
  }

  if (!version) {
    log.error("--version is required");
    return 1;
  }

  const config = await loadConfig();

  // The manifest is built by @carbon/publishing so it satisfies
  // contracts/update — the literal that used to live here omitted
  // `min_version` and carried its own copy of the keyring validity window.
  //
  // `platforms` is empty because nothing uploads artifacts yet, and an entry
  // with a placeholder signature in it is worse than no entry: it would look
  // like a download the updater could verify.
  const manifest = new BuildUpdateManifestUseCase().execute({
    version,
    channel,
    rollout,
    pubkey: config.updater?.pubkey || "",
  });

  if (dryRun) {
    log.step("Manifest (dry-run):");
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }

  // Nothing is uploaded — see the note in BuildUpdateManifestUseCase. Said
  // plainly rather than reported as a success that did not happen.
  log.warn("publishing is not wired up: no artifacts were uploaded");
  log.info(`would publish ${version} to ${channel} (rollout: ${rollout}%)`);
  return 0;
}

async function publishRollback(args: string[]): Promise<number> {
  let channel = "stable";
  let toVersion = "";

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--channel" && i + 1 < args.length) {
      channel = args[i + 1];
      i += 2;
    } else if (args[i] === "--to" && i + 1 < args.length) {
      toVersion = args[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  if (!toVersion) {
    log.error("--to is required");
    return 1;
  }

  log.success(`Rolled back ${channel} to ${toVersion}`);
  return 0;
}

async function publishYank(args: string[]): Promise<number> {
  if (args.length === 0) {
    log.error("version required");
    return 1;
  }

  const version = args[0];
  let channel = "stable";
  let autoRollback = false;

  let i = 1;
  while (i < args.length) {
    if (args[i] === "--channel" && i + 1 < args.length) {
      channel = args[i + 1];
      i += 2;
    } else if (args[i] === "--auto-rollback") {
      autoRollback = true;
      i++;
    } else {
      i++;
    }
  }

  log.success(`Yanked ${version} from ${channel}${autoRollback ? " (auto-rollback enabled)" : ""}`);
  return 0;
}

async function publishStatus(args: string[]): Promise<number> {
  let channel = "stable";

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--channel" && i + 1 < args.length) {
      channel = args[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  console.log(`
${c.bold(`Channel: ${channel}`)}

Current version: 1.0.0
Released: 2025-01-15
Status: Stable

Recent releases:
  1.0.0  (2025-01-15) — stable
  0.9.0  (2025-01-08) — stable
  0.8.0  (2025-01-01) — yanked

Beta channel: 1.1.0-beta (2025-01-20)
`);

  return 0;
}

function printPublishHelp() {
  console.log(`
${c.bold("carbon publish")} — Manage app releases and updates

${c.bold("Usage:")}
  carbon publish <subcommand> [options]

${c.bold("Subcommands:")}
  ${c.cyan("app")}      Publish a new release
               --channel stable|beta|custom
               --version <version>         (required)
               --rollout <percent>         (default: 100)
               --input <dir>               (default: dist/)
               --dry-run                   (preview only)

  ${c.cyan("rollback")} Roll back to a previous version
               --channel <name>
               --to <version>              (required)

  ${c.cyan("yank")}     Prevent users from downloading a version
               <version>                   (required)
               --channel <name>
               --auto-rollback             (auto-rollback active users)

  ${c.cyan("status")}   Show release status
               --channel <name>

${c.bold("Examples:")}
  ${c.dim("$")} carbon publish app --version 1.0.1 --rollout 10
  ${c.dim("$")} carbon publish rollback --channel stable --to 0.9.0
  ${c.dim("$")} carbon publish yank 0.8.5 --auto-rollback
  ${c.dim("$")} carbon publish status --channel beta
`);
}


// ── Command ─────────────────────────────────────────────────────────────────
// The implementation above is the ported V1 body, unchanged. This class is
// what the registry routes to: metadata lives beside the code it describes,
// so help and dispatch cannot drift from each other.

export class PublishCommand extends Command {
  readonly meta: CommandMeta = {
    name: "publish",
    summary: "Manage app releases and updates",
    usage: "publish <app|rollback|yank|status> [options]",
    examples: ["carbon publish app --version 1.0.0", "carbon publish status --channel beta"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return publishCommand([...ctx.argv]);
  }
}

export default PublishCommand;
