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
    defineCommand(
      { name: "setup-verification", description: "Post the Carbon Native verification and onboarding panel to this channel" },
      async () => new (await import("../presentation/commands/onboarding/setup-verification.command.ts")).SetupVerificationCommand(),
    ),
    defineCommand(
      { name: "ticket-panel", description: "Deploy the Carbon Native support ticket panel to this channel" },
      async () => new (await import("../presentation/commands/ticketing/ticket-panel.command.ts")).TicketPanelCommand(),
    ),
    defineCommand(
      { name: "suggest", description: "Submit a proposal or feature suggestion for the Carbon Native community to vote on" },
      async () => new (await import("../presentation/commands/community/suggest.command.ts")).SuggestCommand(),
    ),
    defineCommand(
      { name: "announce", description: "Broadcast an official announcement to a designated channel" },
      async () => new (await import("../presentation/commands/broadcast/announce.command.ts")).AnnounceCommand(),
    ),
    defineCommand(
      { name: "release", description: "Publish a Carbon Native release announcement card" },
      async () => new (await import("../presentation/commands/release/release.command.ts")).ReleaseCommand(),
    ),
    defineCommand(
      { name: "issue", description: "Report or search community bug reports and issues" },
      async () => new (await import("../presentation/commands/community/issue.command.ts")).IssueCommand(),
    ),
    defineCommand(
      { name: "event", description: "Create or view scheduled community events and meetups" },
      async () => new (await import("../presentation/commands/community/event.command.ts")).EventCommand(),
    ),
    defineCommand(
      { name: "setup-roles", description: "Deploy the self-service role & notification picker panel" },
      async () => new (await import("../presentation/commands/community/setup-roles.command.ts")).SetupRolesCommand(),
    ),
    defineCommand(
      { name: "resolve", description: "Mark this help thread as resolved, rename with [SOLVED], and archive" },
      async () => new (await import("../presentation/commands/community/resolve-thread.command.ts")).ResolveThreadCommand(),
    ),
  );
}
