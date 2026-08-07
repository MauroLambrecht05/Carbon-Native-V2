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
import { CARBON_ROOT } from "@carbon/workspace";
import { resolve } from "node:path";

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
    usage: "plugin new <name> [--lang rust|zig]",
    flags: [
      { name: "lang", short: "l", placeholder: "rust|zig", description: "Implementation language", default: "rust" },
    ],
    examples: ["carbon plugin new my-thing", "carbon plugin new my-thing --lang zig"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.first ? null : "plugin new requires a name. Try: carbon plugin new my-thing";
  }

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const { create, sdkRoot } = pluginUseCases(CARBON_ROOT);
      const result = create.execute({
        name: ctx.first!,
        language: ctx.flags.get("lang", "rust"),
        cwd: ctx.cwd,
        sdkRoot,
      });

      ctx.io.success(
        `${ctx.io.c.bold(result.name.slug)} scaffolded at ${ctx.io.c.dim(forwardSlashes(result.target))}`,
      );
      ctx.io.info(`${ctx.io.c.dim("next:")} ${result.nextStep}`);
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
      const result = await pluginUseCases(CARBON_ROOT).build.execute({
        directory: ctx.cwd,
        release: ctx.flags.bool("release"),
      });

      if (result.exitCode === 0) {
        const how = result.language.id === "zig" ? "zig" : result.release ? "release" : "debug";
        ctx.io.success(`plugin built (${how})`);
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
      const { install } = pluginUseCases(CARBON_ROOT);
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

class ListPluginsCommand extends Command {
  readonly meta: CommandMeta = {
    name: "list",
    summary: "List the plugins installed in this app",
    usage: "plugin list",
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const { host, plugins } = pluginUseCases(CARBON_ROOT).inspect.list(ctx.cwd);

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
      const details = pluginUseCases(CARBON_ROOT).inspect.describe(ctx.first!, ctx.cwd);

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
    summary: "Manage native plugins (new / build / install / list / info)",
    usage: "plugin <subcommand> [options]",
    examples: ["carbon plugin new my-plugin", "carbon plugin list"],
  };

  readonly subcommands = [
    new NewPluginCommand(),
    new BuildPluginCommand(),
    new InstallPluginCommand(),
    new ListPluginsCommand(),
    new InfoPluginCommand(),
  ];
}

export default PluginCommand;
export { EXIT_USAGE };
