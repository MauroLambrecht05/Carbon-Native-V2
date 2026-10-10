import type { ChatInputCommandInteraction } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { buildTicketModal } from "../../support/ticket-modal.ts";

export class SupportCommand extends Command {
  readonly meta: CommandMeta = { name: "support", description: "Open a private Carbon support request" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Support requests must be opened from the Carbon server.", ephemeral: true });
      return;
    }
    await interaction.showModal(buildTicketModal());
  }
}
