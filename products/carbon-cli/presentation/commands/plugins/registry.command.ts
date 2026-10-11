// `carbon plugin registry <subcommand>` — packages from Carbon Registry.
//
// All the work is RegistryPlugins in @carbon/catalog. What is left here is
// argv in, output out.

import { Command, CommandGroup, EXIT_FAILURE, EXIT_OK, type CommandContext, type CommandMeta, type ExitCode } from "@carbon/cli";
import { DECLARATION_PATH, LOCK_PATH, RegistryPluginError, type RegistryPlugins } from "@carbon/catalog";
import { pluginUseCases } from "@carbon/lifecycle";
import { PRODUCTS_DIR } from "@carbon/workspace";
import { join } from "node:path";
import { registryPlugins } from "../../../composition/registry-plugins.ts";

/** Builds the use cases for a project directory. Replaced in tests. */
export type RegistryPluginsFactory = (projectRoot: string) => RegistryPlugins;

function project(ctx: CommandContext): string {
  return pluginUseCases(join(PRODUCTS_DIR, "carbon-ext")).workspace.findHostApp(ctx.cwd) ?? ctx.cwd;
}
/** Runs `body`, turning a refusal into a message and a failing exit code. Anything else is a bug and keeps its stack. */
async function reporting(ctx: CommandContext, body: () => Promise<ExitCode> | ExitCode): Promise<ExitCode> {
  try { return await body(); } catch (error) {
    if (error instanceof RegistryPluginError) { ctx.io.error(error.message); return EXIT_FAILURE; }
    throw error;
  }
}
function approvals(ctx: CommandContext): readonly string[] | "all" {
  if (ctx.flags.bool("approve-all")) return "all";
  return (ctx.flags.get("approve") ?? "").split(",").map(item => item.trim()).filter(Boolean);
}
const APPROVAL_FLAGS = [
  { name: "approve", placeholder: "<capabilities>", description: "Capabilities you have reviewed and accept, comma-separated" },
  { name: "approve-all", boolean: true, description: "Accept every capability the chosen versions ask for" },
];

abstract class RegistrySubcommand extends Command {
  constructor(protected readonly factory: RegistryPluginsFactory) { super(); }
}

class InitCommand extends RegistrySubcommand {
  readonly meta: CommandMeta = {
    name: "init", summary: "Record which Registry and which root key this project trusts", usage: "plugin registry init --registry <url> --root-key <key>",
    flags: [{ name: "registry", placeholder: "<url>", description: "The Registry's origin" }, { name: "root-key", placeholder: "<hex>", description: "The Registry's root public key, from a source you trust" }],
  };
  validate(ctx: CommandContext): string | null { return ctx.flags.get("registry") && ctx.flags.get("root-key") ? null : "plugin registry init requires --registry and --root-key"; }
  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const declaration = this.factory(project(ctx)).init(ctx.flags.get("registry")!, ctx.flags.get("root-key")!);
      ctx.io.success(`${DECLARATION_PATH} trusts ${ctx.io.c.bold(declaration.registry)}`);
      ctx.io.info("Commit this file: the root key in it is what every install is checked against.");
      return EXIT_OK;
    });
  }
}

class AddCommand extends RegistrySubcommand {
  readonly meta: CommandMeta = {
    name: "add", summary: "Resolve, verify, lock and install a package", usage: "plugin registry add <publisher/name[@range]> [options]", flags: APPROVAL_FLAGS,
    examples: ["carbon plugin registry add acme/clipboard", "carbon plugin registry add acme/clipboard@^1.2.0 --approve clipboard.read"],
  };
  validate(ctx: CommandContext): string | null { return ctx.first ? null : "plugin registry add requires a package. Try: carbon plugin registry add acme/clipboard"; }
  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, async () => {
      const change = await this.factory(project(ctx)).add(ctx.first!, approvals(ctx));
      ctx.io.success(`${ctx.io.c.bold(change.name)} ${change.to} installed and locked (signature and digest verified)`);
      if (change.capabilities.length) ctx.io.info(`${ctx.io.c.dim("·")} approved capabilities: ${change.capabilities.join(", ")}`);
      ctx.io.info(`${ctx.io.c.dim("·")} commit ${DECLARATION_PATH} and ${LOCK_PATH}`);
      return EXIT_OK;
    });
  }
}

class InstallCommand extends RegistrySubcommand {
  readonly meta: CommandMeta = {
    name: "install", summary: "Install exactly what the lock file names", usage: "plugin registry install [--offline]",
    flags: [{ name: "offline", boolean: true, description: "Use only this machine's cache; fail rather than reach the network" }],
  };
  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, async () => {
      const report = await this.factory(project(ctx)).install({ offline: ctx.flags.bool("offline") });
      for (const name of report.installed) ctx.io.success(`${ctx.io.c.bold(name)} installed (signature and digest verified)`);
      for (const name of report.removed) ctx.io.info(`${ctx.io.c.dim("·")} removed ${name}, which the lock no longer names`);
      if (!report.installed.length) ctx.io.info(`Up to date: ${report.unchanged.length} package${report.unchanged.length === 1 ? "" : "s"} match the lock`);
      return EXIT_OK;
    });
  }
}

class UpdateCommand extends RegistrySubcommand {
  readonly meta: CommandMeta = { name: "update", summary: "Move locked packages to the newest version their range allows", usage: "plugin registry update [publisher/name] [options]", flags: APPROVAL_FLAGS };
  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, async () => {
      const changes = await this.factory(project(ctx)).update(ctx.first, approvals(ctx));
      for (const change of changes) ctx.io.success(`${ctx.io.c.bold(change.name)} ${change.from ?? "(not locked)"} → ${change.to}`);
      if (!changes.length) ctx.io.info("Nothing to update: every package is at the newest version its range allows");
      else ctx.io.info(`${ctx.io.c.dim("·")} commit ${LOCK_PATH}`);
      return EXIT_OK;
    });
  }
}

class RemoveCommand extends RegistrySubcommand {
  readonly meta: CommandMeta = { name: "remove", summary: "Remove a package from the declaration, the lock and the disk", usage: "plugin registry remove <publisher/name>" };
  validate(ctx: CommandContext): string | null { return ctx.first ? null : "plugin registry remove requires a package"; }
  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => { const change = this.factory(project(ctx)).remove(ctx.first!); ctx.io.success(`${ctx.io.c.bold(change.name)} removed`); return EXIT_OK; });
  }
}

class AuditCommand extends RegistrySubcommand {
  readonly meta: CommandMeta = { name: "audit", summary: "Ask Registry about every locked version and check every installed file", usage: "plugin registry audit" };
  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, async () => {
      const findings = await this.factory(project(ctx)).audit();
      if (!findings.length) { ctx.io.success("Every locked package is published, unchanged and installed as locked"); return EXIT_OK; }
      for (const finding of findings) ctx.io[finding.problem === "yanked" ? "info" : "error"](`${finding.name} ${finding.version}: ${finding.problem.replace("_", " ")}${finding.reason ? ` (${finding.reason})` : ""}`);
      // A yanked version still installs; everything else needs someone to act.
      return findings.every(finding => finding.problem === "yanked") ? EXIT_OK : EXIT_FAILURE;
    });
  }
}

class ListCommand extends RegistrySubcommand {
  readonly meta: CommandMeta = { name: "list", summary: "Show declared packages, their locked versions and whether they are installed", usage: "plugin registry list" };
  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const rows = this.factory(project(ctx)).list();
      if (!rows.length) ctx.io.info(`No packages declared in ${DECLARATION_PATH}`);
      for (const row of rows) ctx.io.raw(`${row.name}  ${row.range}  ${row.version ?? "(not locked)"}  ${row.installed ? "installed" : "not installed"}\n`);
      return EXIT_OK;
    });
  }
}

export class RegistryPluginCommand extends CommandGroup {
  readonly meta: CommandMeta = {
    name: "registry", summary: "Install packages from Carbon Registry (init / add / install / update / remove / audit / list)", usage: "plugin registry <subcommand> [options]",
    examples: ["carbon plugin registry init --registry https://registry.example --root-key <hex>", "carbon plugin registry add acme/clipboard", "carbon plugin registry install --offline"],
  };
  readonly subcommands: readonly Command[];
  constructor(factory: RegistryPluginsFactory = root => registryPlugins(root)) {
    super();
    this.subcommands = [new InitCommand(factory), new AddCommand(factory), new InstallCommand(factory), new UpdateCommand(factory), new RemoveCommand(factory), new AuditCommand(factory), new ListCommand(factory)];
  }
}
