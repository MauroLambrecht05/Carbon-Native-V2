// `carbon plugin <subcommand>` — manage native plugins.
//
// A CommandGroup with one class per subcommand, like `signer`. The previous
// version was a hand-rolled switch over argv with its own help string, which
// meant `carbon help plugin` could not see the subcommands and none of them
// declared their flags.
//
// All the work is @carbon/plugin. What is left here is argv in, output out.

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
import {
  devSigningKeyPath,
  forwardSlashes,
  generateDevSigningKey,
  hasDevSigningKey,
  MissingSigningKeyError,
  PluginError,
  pluginUseCases,
  readDevSigningPublicKey,
  setManifestEnabled,
} from "@carbon/lifecycle";
import { PRODUCTS_DIR } from "@carbon/workspace";
import { join, resolve } from "node:path";

/**
 * Where the plugin SDK lives.
 *
 * carbon-ext IS the SDK — the C ABI header an author includes, the templates
 * `plugin new` scaffolds from, and the build.zig that wires them to the
 * implementation in solutions. @carbon/plugin cannot work this out for
 * itself: it is a solution, and a solution may not name a path inside a
 * product. So this product, which knows where its siblings are, hands it over.
 */
const SDK_ROOT = join(PRODUCTS_DIR, "carbon-ext");

/**
 * Where the STANDARD plugins live — one subdirectory per plugin, each a
 * normal buildable+installable plugin like any other (see `fonts/`). This is
 * a separate product from `carbon-ext` on purpose: carbon-ext is the SDK
 * (what a plugin AUTHOR builds against), carbon-sdk is the curated
 * collection `carbon plugin add <name>` (and SyncPluginsUseCase's auto-heal)
 * resolves names against — a user never sees carbon-ext's path at all.
 */
const STANDARD_PLUGINS_ROOT = join(PRODUCTS_DIR, "carbon-sdk");

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
    if (e instanceof PluginError || e instanceof MissingSigningKeyError) {
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
      const { create, workspace, sdkRoot } = pluginUseCases(SDK_ROOT, STANDARD_PLUGINS_ROOT);

      // Scaffold into <host>/carbon/plugins/local/ when run from inside an
      // app — the app's own plugin-development area, auto-built by
      // SyncPluginsUseCase on every `carbon dev`/`run` — regardless of which
      // subdirectory of the app the command was actually run from. Falls
      // back to plain cwd when there's no host app above (e.g. scaffolding
      // one of carbon-sdk's own standard plugins, which don't live inside
      // any single app's carbon/plugins/local/).
      const host = workspace.findHostApp(ctx.cwd);
      const cwd = host ? join(host, "carbon", "plugins", "local") : ctx.cwd;

      const result = create.execute({
        name: ctx.first!,
        cwd,
        sdkRoot,
        host: host ?? undefined,
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
        logger: ctx.io,
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
    summary: "Copy a built plugin into the host app as a vendor plugin",
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
        `${ctx.io.c.dim("·")} declared ${result.name.slug} (source = "vendor") ` +
          `in ${forwardSlashes(result.host)}/carbon/manifest.toml`,
      );
      return EXIT_OK;
    });
  }
}

class AddPluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "add",
    summary: "Build + sign + install a standard plugin from carbon-sdk into this app",
    usage: "plugin add <name> [project-dir]",
    examples: ["carbon plugin add fonts", "carbon plugin add fonts ./my-app"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.first ? null : "plugin add requires a name. Try: carbon plugin add fonts";
  }

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, async () => {
      const name = ctx.first!;
      // Second positional, like `carbon dev [project-dir]` — which app to
      // install into. Defaults to cwd (run `carbon plugin add fonts` from
      // inside the app, same as `plugin install`).
      const targetApp = ctx.args[1] ? resolve(ctx.cwd, ctx.args[1]) : ctx.cwd;

      const { addStandard } = pluginUseCases(SDK_ROOT, STANDARD_PLUGINS_ROOT);
      const result = await addStandard.execute({ name, targetApp, logger: ctx.io });

      ctx.io.success(
        `${ctx.io.c.bold(result.name.slug)} added → ${ctx.io.c.dim(forwardSlashes(result.installedAt))}`,
      );
      ctx.io.info(
        `${ctx.io.c.dim("·")} declared ${result.name.slug} (source = "vendor") ` +
          `in ${forwardSlashes(result.host)}/carbon/manifest.toml`,
      );
      return EXIT_OK;
    });
  }
}

/** Shared body for enable/disable: flip carbon/manifest.toml's `enabled`. */
function toggle(ctx: CommandContext, name: string, enabled: boolean): ExitCode {
  const { workspace } = pluginUseCases(SDK_ROOT);
  const host = workspace.findHostApp(ctx.cwd);
  if (!host) {
    ctx.io.error("no carbon.toml found — run this from inside an app");
    return EXIT_FAILURE;
  }
  const manifestPath = join(host, "carbon", "manifest.toml");
  if (!workspace.exists(manifestPath)) {
    ctx.io.error(`no carbon/manifest.toml at ${forwardSlashes(host)} — this app has no plugins yet`);
    return EXIT_FAILURE;
  }

  const before = workspace.readFile(manifestPath);
  const after = setManifestEnabled(before, name, enabled);
  if (before === after) {
    ctx.io.error(`no plugin named "${name}" declared in carbon/manifest.toml`);
    return EXIT_FAILURE;
  }
  workspace.writeFile(manifestPath, after);
  ctx.io.success(`${ctx.io.c.bold(name)} ${enabled ? "enabled" : "disabled"}`);
  return EXIT_OK;
}

class EnablePluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "enable",
    summary: "Re-enable a plugin declared in carbon/manifest.toml",
    usage: "plugin enable <name>",
    examples: ["carbon plugin enable fonts"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.first ? null : "plugin enable requires a name";
  }

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => toggle(ctx, ctx.first!, true));
  }
}

class DisablePluginCommand extends Command {
  readonly meta: CommandMeta = {
    name: "disable",
    summary: "Stop building/loading a plugin without removing its directory",
    usage: "plugin disable <name>",
    examples: ["carbon plugin disable fonts"],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.first ? null : "plugin disable requires a name";
  }

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => toggle(ctx, ctx.first!, false));
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
    summary: "List the plugins declared for this app",
    usage: "plugin list",
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, () => {
      const { host, plugins } = pluginUseCases(SDK_ROOT).inspect.list(ctx.cwd);

      if (plugins.length === 0) {
        ctx.io.info(`no plugins declared in ${forwardSlashes(host)}/carbon/manifest.toml`);
        return EXIT_OK;
      }

      ctx.io.info(`plugins for ${forwardSlashes(host)}:`);
      for (const plugin of plugins) {
        const tags: string[] = [plugin.source];
        if (!plugin.enabled) tags.push("disabled");
        if (!plugin.present) tags.push("missing");
        if (plugin.capabilities.length) tags.push(plugin.capabilities.join(","));
        ctx.io.raw(`  ${plugin.name} ${ctx.io.c.dim(`(${tags.join(" · ")})`)}`);
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

class DevKeyCommand extends Command {
  readonly meta: CommandMeta = {
    name: "dev-key",
    summary: "Generate (or show) this machine's local-plugin dev-signing key",
    usage: "plugin dev-key",
    examples: ["carbon plugin dev-key"],
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return reporting(ctx, async () => {
      const existed = hasDevSigningKey();
      const hex = existed ? await readDevSigningPublicKey(ctx.io) : await generateDevSigningKey(ctx.io);

      if (existed) {
        ctx.io.info(`dev-signing key already exists at ${ctx.io.c.dim(forwardSlashes(devSigningKeyPath()))}`);
      } else {
        ctx.io.success(`dev-signing key generated at ${ctx.io.c.dim(forwardSlashes(devSigningKeyPath()))}`);
      }
      ctx.io.raw("");
      ctx.io.raw(`public key: ${hex}`);
      ctx.io.raw("");
      ctx.io.info("add it to every project's carbon.toml that should load this machine's locally-built plugins:");
      ctx.io.raw("");
      ctx.io.raw("  [dev-signing]");
      ctx.io.raw(`  trusted_keys = ["${hex}"]`);
      ctx.io.raw("");
      return EXIT_OK;
    });
  }
}

export class PluginCommand extends CommandGroup {
  readonly meta: CommandMeta = {
    name: "plugin",
    summary: "Manage native plugins (new / add / build / check / install / enable / disable / list / info / dev-key)",
    usage: "plugin <subcommand> [options]",
    examples: ["carbon plugin add fonts", "carbon plugin new my-plugin", "carbon plugin list"],
  };

  readonly subcommands = [
    new NewPluginCommand(),
    new AddPluginCommand(),
    new BuildPluginCommand(),
    new CheckPluginCommand(),
    new InstallPluginCommand(),
    new EnablePluginCommand(),
    new DisablePluginCommand(),
    new ListPluginsCommand(),
    new InfoPluginCommand(),
    new DevKeyCommand(),
  ];
}

export default PluginCommand;
export { EXIT_USAGE };
