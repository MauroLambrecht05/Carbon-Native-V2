// `carbon plugin <subcommand>` — manage native plugins.
//
// A CommandGroup with one class per subcommand, like `signer`. The previous
// version was a hand-rolled switch over argv with its own help string, which
// meant `carbon help plugin` could not see the subcommands and none of them
// declared their flags.
//
// All the work is @carbon/plugins. What is left here is argv in, output out.

import {
  Command,
  CommandGroup,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
  type CommandMeta,
  type ExitCode,
} from "@carbon/cli";
import { forwardSlashes, PluginError, pluginUseCases } from "@carbon/plugins";
import { PRODUCTS_DIR } from "@carbon/workspace";
import { join, resolve } from "node:path";

/**
 * Where the plugin SDK lives.
 *
 * carbon-ext IS the SDK — the C ABI header an author includes, the templates
 * `plugin new` scaffolds from, and the build.zig that wires them to the
 * implementation in solutions. @carbon/plugins cannot work this out for
 * itself: it is a solution, and a solution may not name a path inside a
 * product. So this product, which knows where its siblings are, hands it over.
 */
const SDK_ROOT = join(PRODUCTS_DIR, "carbon-ext");

/**
 * Runs `body`, turning the capability's own refusals into a usage error.
 *
 * A PluginError is a message for the user; anything else is a bug and should
 * surface with its stack rather than being flattened into "exit 1".
 */
async function reporting(
  ctx: CommandContext,
  body: () => Promise<ExitCode> | ExitCode,
): Promise<ExitCode> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof PluginError) {
      ctx.io.error(e.message);
      return EXIT_FAILURE;
    }
    throw e;
  }
}

class NewPluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "new",
    summary: "Scaffold a new native plugin",
    usage: "plugin new <name>",
    // No --lang. Carbon plugins are Zig; the flag used to choose between Zig
    // and Rust, and offering a choice that has one option is worse than
    // offering none — it implies the other still works.
    examples: ["carbon plugin new my-thing"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.first ? null : "plugin new requires a name. Try: carbon plugin new my-thing";
  }

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const { create, sdkRoot } = pluginUseCases(SDK_ROOT);
      const result = create.execute({
        name: ctx.first!,
        cwd: ctx.cwd,
        sdkRoot,
      });

      ctx.io.success(
        `${ctx.io.c.bold(result.name.slug)} scaffolded at ${ctx.io.c.dim(forwardSlashes(result.target))}`,
      );
      ctx.io.info(`${ctx.io.c.dim("next:")} ${result.nextStep}`);
      ctx.io.info(
        `${ctx.io.c.dim("points:")} it implements lifecycle.register — ` +
          `${ctx.io.c.dim("carbon ext list")} shows the rest`,
      );
      return EXIT_OK;
    });
  }
}

class BuildPluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "build",
    summary: "Build the plugin in the current directory",
    usage: "plugin build [--release]",
    flags: [{ name: "release", short: "r", boolean: true, description: "Optimised build" }],
    examples: ["carbon plugin build --release"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, async () => {
      const result = await pluginUseCases(SDK_ROOT).build.execute({
        directory: ctx.cwd,
        release: ctx.flags.bool("release"),
      });

      if (result.exitCode === 0) {
        ctx.io.success(`plugin built (${result.release ? "ReleaseFast" : "debug"})`);
      }
      // The compiler has already explained itself on stderr; adding our own
      // message on top would only bury it.
      return result.exitCode;
    });
  }
}

class InstallPluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "install",
    summary: "Copy a built plugin into the host app and declare it",
    usage: "plugin install [dir]",
    examples: ["carbon plugin install", "carbon plugin install ./my-thing"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const { install } = pluginUseCases(SDK_ROOT);
      // An explicit directory may be absolute or relative; resolve() handles
      // both, and defaults to the cwd when none was given.
      const directory = ctx.first ? resolve(ctx.cwd, ctx.first) : ctx.cwd;

      const result = install.execute({ directory, from: ctx.cwd });

      ctx.io.success(
        `${ctx.io.c.bold(result.name.slug)} installed → ${ctx.io.c.dim(forwardSlashes(result.installedAt))}`,
      );
      ctx.io.info(
        `${ctx.io.c.dim("·")} added [plugins] ${result.name.slug} = "${result.declaredPath}" ` +
          `to ${forwardSlashes(result.host)}/carbon.toml`,
      );
      return EXIT_OK;
    });
  }
}

class CheckPluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "check",
    summary: "Verify a plugin's manifest against the extension-point registry",
    usage: "plugin check [dir]",
    examples: ["carbon plugin check", "carbon plugin check ./my-thing"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const directory = ctx.first ? resolve(ctx.cwd, ctx.first) : ctx.cwd;
      const result = pluginUseCases(SDK_ROOT).check.execute(directory);

      for (const point of result.points) {
        const tags = [`1.${point.sinceMinor}`];
        if (point.capability) tags.push(`needs ${point.capability}`);
        ctx.io.raw(`  ${ctx.io.c.dim("point")}  ${point.id} ${ctx.io.c.dim(`(${tags.join(" · ")})`)}`);
      }

      for (const finding of result.findings) {
        const label = finding.severity === "error" ? ctx.io.c.bold("error") : "warn ";
        ctx.io.raw(`  ${label}  ${finding.message}`);
        if (finding.fix) ctx.io.raw(`         ${ctx.io.c.dim(finding.fix)}`);
      }

      if (!result.ok) {
        ctx.io.error(`${result.name || "plugin"} would not load as declared`);
        return EXIT_FAILURE;
      }

      const warnings = result.findings.length;
      ctx.io.success(
        `${result.name} declares ${result.points.length} extension point(s)` +
          (warnings > 0 ? `, with ${warnings} warning(s)` : ""),
      );
      return EXIT_OK;
    });
  }
}

class ListPluginsCommand extends Command {
  readonly meta: CommandMeta = {
    name: "list",
    summary: "List the plugins installed in this app",
    usage: "plugin list",
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const { host, plugins } = pluginUseCases(SDK_ROOT).inspect.list(ctx.cwd);

      if (plugins.length === 0) {
        ctx.io.info(`no plugins installed in ${forwardSlashes(host)}`);
        return EXIT_OK;
      }

      ctx.io.info(`plugins for ${forwardSlashes(host)}:`);
      for (const plugin of plugins) {
        // A declared-but-absent plugin is normal after a clean, and worth
        // flagging rather than hiding — it is why the app fails to start.
        const marker = plugin.present ? "" : ctx.io.c.dim(" (missing)");
        ctx.io.raw(`  ${plugin.name} -> ${plugin.path}${marker}`);
      }
      return EXIT_OK;
    });
  }
}

class InfoPluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "info",
    summary: "Show details for one plugin",
    usage: "plugin info <name>",
    examples: ["carbon plugin info my-thing"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.first ? null : "info requires a plugin name";
  }

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const details = pluginUseCases(SDK_ROOT).inspect.describe(ctx.first!, ctx.cwd);

      ctx.io.raw(`[${details.origin}]`);
      ctx.io.raw(`  path: ${forwardSlashes(details.path)}`);
      if (details.manifest) {
        ctx.io.raw("---");
        ctx.io.raw(details.manifest);
      }
      return EXIT_OK;
    });
  }
}

export class PluginCommand extends CommandGroup {
  readonly meta: CommandMeta = {
    name: "plugin",
    summary: "Manage native plugins (new / build / check / install / list / info)",
    usage: "plugin <subcommand> [options]",
    examples: ["carbon plugin new my-plugin", "carbon plugin list"],
  };

  readonly subcommands = [
    new NewPluginCommand(),
    new BuildPluginCommand(),
    new CheckPluginCommand(),
    new InstallPluginCommand(),
    new ListPluginsCommand(),
    new InfoPluginCommand(),
  ];
}

export default PluginCommand;
export { EXIT_USAGE };
