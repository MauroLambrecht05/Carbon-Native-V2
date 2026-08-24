// The first real slash command, proves the whole pipeline end to end:
// Discord dispatches an interaction over the gateway, the router looks it up
// and calls this, this replies to the user who typed /ping.

import type { ChatInputCommandInteraction } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class PingCommand extends Command {
  readonly meta: CommandMeta = {
    name: "ping",
    description: "Check that the bot is alive",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply("Pong!");
  }
}
