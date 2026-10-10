import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { optionalHttpUrl } from "../../../infrastructure/config/environment.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class StatusCommand extends Command {
  readonly meta: CommandMeta = { name: "status", description: "Open Carbon's authoritative service status" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const statusUrl = optionalHttpUrl("STATUS_URL");
    if (!statusUrl) {
      await interaction.reply({
        content: "Carbon does not have an authoritative public status endpoint yet. Bot connectivity is not presented as product health.",
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Carbon service status").setDescription("Current incidents, maintenance, and service availability are published on the status page.").setColor(0x2b7a4b)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel("Open status page").setURL(statusUrl).setStyle(ButtonStyle.Link))],
      ephemeral: true,
    });
  }
}
