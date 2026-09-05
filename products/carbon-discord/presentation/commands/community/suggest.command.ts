import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class SuggestCommand extends Command {
  readonly meta: CommandMeta = {
    name: "suggest",
    description: "Submit a proposal or feature suggestion for the Carbon Native community to vote on",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId("modal:suggest-create")
      .setTitle("Submit Community Suggestion");

    const titleInput = new TextInputBuilder()
      .setCustomId("suggest-title")
      .setLabel("Suggestion Title")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. Add FlatBuffers zero-copy schema generator for Go")
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(100);

    const detailsInput = new TextInputBuilder()
      .setCustomId("suggest-details")
      .setLabel("Details & Problem Description")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Explain what you would like to see, why it matters, and how it benefits developers...")
      .setRequired(true)
      .setMinLength(15)
      .setMaxLength(1000);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(detailsInput),
    );

    await interaction.showModal(modal);
  }
}
