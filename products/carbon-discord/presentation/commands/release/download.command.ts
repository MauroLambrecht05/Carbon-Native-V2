// Deliberately honest rather than useful-looking: there is no public
// repository and no installer pipeline has ever run (no git tags exist, and
// .config/_identity.json's "homepage" 404s: it's aspirational metadata, not
// a live location). Claiming otherwise here would send someone to a dead
// link, which is exactly what this project's own tooling refuses to do
// elsewhere; see carbon-cloud's publish command warning instead of
// reporting a publish that did not happen.

import type { ChatInputCommandInteraction } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class DownloadCommand extends Command {
  readonly meta: CommandMeta = {
    name: "download",
    description: "Get Carbon: installer or source",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply(
      "**Carbon isn't packaged for download yet.**\n" +
        "No installer has been published and there's no public repository to clone from. " +
        "This project is pre-release. Once a build ships, this command will link straight to it.",
    );
  }
}
