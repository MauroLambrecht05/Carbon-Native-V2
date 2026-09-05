// Every command the CLI has, in one place.
//
// This is the only file that changes when a command is added. Metadata is
// declared here and the implementation is behind a `load()` thunk, so the
// registry can render `carbon --help`, resolve aliases and suggest fixes for
// typos without importing a single command module.
//
// That laziness is load-bearing, not a micro-optimisation. `build`, `run` and
// `dev` transitively pull in vite, rollup and babel; evaluating those modules
// costs more than everything else a help invocation does. V1 preserved this
// with a switch of dynamic imports inside main.ts — the behaviour is kept,
// but the command list is now data the help renderer and the typo-suggester
// can both read, instead of control flow only the dispatcher could follow.
//
// The duplicated `meta` here and on the class is deliberate: the descriptor's
// copy is what stays cheap. `assertRegistryMatchesCommands` in the test suite
// loads every command and fails if the two ever disagree.

import { CommandRegistry, defineCommand } from "@carbon/cli";

export function buildRegistry(): CommandRegistry {
  return new CommandRegistry().register(
    defineCommand(
      {
        name: "init",
        aliases: ["new"],
        summary: "Scaffold a new project",
        usage: "init <name> [options]",
      },
      async () => new (await import("../presentation/commands/project/init.command.ts")).InitCommand(),
    ),

    defineCommand(
      {
        name: "run",
        summary: "Build everything that needs building, then launch the app",
        usage: "run [project-dir] [options]",
      },
      async () => new (await import("../presentation/commands/build/run.command.ts")).RunCommand(),
    ),

    defineCommand(
      {
        name: "build",
        summary: "Build UI + shell + runtime, but don't launch",
        usage: "build [project-dir] [options]",
      },
      async () => new (await import("../presentation/commands/build/build.command.ts")).BuildCommand(),
    ),

    defineCommand(
      {
        name: "dev",
        summary: "Watch source, auto-rebuild + auto-relaunch on change",
        usage: "dev [project-dir] [options]",
      },
      async () => new (await import("../presentation/commands/build/dev.command.ts")).DevCommand(),
    ),

    defineCommand(
      {
        name: "bundle",
        summary: "Create OS-specific installers",
        usage: "bundle [options]",
      },
      async () => new (await import("../presentation/commands/build/bundle.command.ts")).BundleCommand(),
    ),

    defineCommand(
      {
        name: "ext",
        summary: "The extension surface plugins plug into (generate / check / list / show)",
        usage: "ext <subcommand> [options]",
      },
      async () =>
        new (await import("../presentation/commands/extensions/ext.command.ts")).ExtCommand(),
    ),

    defineCommand(
      {
        name: "plugin",
        summary: "Manage native plugins (new / add / search / publish / build / check / install / enable / disable / list / info / dev-key)",
        usage: "plugin <subcommand> [options]",
      },
      async () => new (await import("../presentation/commands/plugins/plugin.command.ts")).PluginCommand(),
    ),

    defineCommand(
      {
        name: "signer",
        summary: "Ed25519 signing and key management",
        usage: "signer <subcommand> [options]",
      },
      async () => new (await import("../presentation/commands/release/signer.command.ts")).SignerCommand(),
    ),

    defineCommand(
      {
        name: "publish",
        summary: "Manage app releases and updates",
        usage: "publish <subcommand> [options]",
      },
      async () => new (await import("../presentation/commands/release/publish.command.ts")).PublishCommand(),
    ),

    defineCommand(
      {
        name: "cloud",
        summary: "Build, sign and publish through Carbon Cloud",
        usage: "cloud <signup|login|worker-token|deploy|list|status> [options]",
      },
      async () => new (await import("../presentation/commands/cloud/cloud.command.ts")).CloudCommand(),
    ),

    defineCommand(
      {
        name: "db",
        summary: "Inspect and query local Carbon Database services",
        usage: "db <status|sql|export> [options]",
      },
      async () => new (await import("../presentation/commands/database/db.command.ts")).DbCommand(),
    ),

    defineCommand(
      {
        name: "doctor",
        summary: "Check toolchain dependencies",
        usage: "doctor",
      },
      async () => new (await import("../presentation/commands/diagnostics/doctor.command.ts")).DoctorCommand(),
    ),

    defineCommand(
      {
        name: "create",
        summary: "Deprecated alias of init",
        usage: "create <name>",
        deprecated: "use `carbon init` instead",
        hidden: true,
      },
      async () => new (await import("../presentation/commands/project/create.command.ts")).CreateCommand(),
    ),
  );
}
