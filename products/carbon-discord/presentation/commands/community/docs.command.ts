import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { optionalHttpUrl } from "../../../infrastructure/config/environment.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class DocsCommand extends Command {
  readonly meta: CommandMeta = { name: "docs", description: "Open the official Carbon documentation" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const docsUrl = optionalHttpUrl("DOCS_URL");
    if (!docsUrl) {
      await interaction.reply({ content: "The public Carbon documentation URL has not been published yet.", ephemeral: true });
      return;
    }
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Carbon documentation").setDescription("Guides, concepts, API references, and troubleshooting maintained by the Carbon team.").setColor(0x00e599)],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel("Open documentation").setURL(docsUrl).setStyle(ButtonStyle.Link))],
      ephemeral: true,
    });
  }
}
