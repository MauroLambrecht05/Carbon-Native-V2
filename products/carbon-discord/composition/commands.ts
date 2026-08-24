// Every slash command the bot has, in one place, mirrors carbon-cli's
// composition/registry.ts. Metadata is declared here and the implementation
// is behind a `load()` thunk, so composition/deploy-commands.ts can read
// every command's name and description without importing a single command
// module. Paired with composition/events.ts for gateway events, which is
// why this is named commands.ts rather than registry.ts: "registry" alone
// stopped saying which one once there were two.

import { CommandRegistry, defineCommand } from "../presentation/framework/command-registry.ts";

export function buildCommandRegistry(): CommandRegistry {
  return new CommandRegistry().register(
    defineCommand(
      { name: "help", description: "List every command Carbon has" },
      async () =>
        new (await import("../presentation/commands/diagnostics/help.command.ts")).HelpCommand(buildCommandRegistry),
    ),
    defineCommand(
      { name: "ping", description: "Check that the bot is alive" },
      async () => new (await import("../presentation/commands/diagnostics/ping.command.ts")).PingCommand(),
    ),
    defineCommand(
      { name: "status", description: "Show the bot's live connection status" },
      async () => new (await import("../presentation/commands/diagnostics/status.command.ts")).StatusCommand(),
    ),
    defineCommand(
      { name: "github", description: "Look up the Carbon Native repository on GitHub" },
      async () => new (await import("../presentation/commands/community/github.command.ts")).GithubCommand(),
    ),
    defineCommand(
      { name: "download", description: "Get Carbon: installer or source" },
      async () => new (await import("../presentation/commands/release/download.command.ts")).DownloadCommand(),
    ),
  );
}
