import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
} from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export class TicketOpenButtonComponent extends Component {
  readonly meta: ComponentMeta = { customId: "ticket:open" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId("modal:ticket-create")
      .setTitle("Open Support Ticket");

    const subjectInput = new TextInputBuilder()
      .setCustomId("ticket-subject")
      .setLabel("Issue Summary / Subject")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. Build failure on Windows or FlatBuffers linking error")
      .setRequired(true)
      .setMinLength(5)
      .setMaxLength(100);

    const categoryInput = new TextInputBuilder()
      .setCustomId("ticket-category")
      .setLabel("Category")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Cloud / Plugin / Bug / General")
      .setRequired(false)
      .setMaxLength(50);

    const descriptionInput = new TextInputBuilder()
      .setCustomId("ticket-description")
      .setLabel("Details & Reproduction Steps")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Please describe the issue in detail, including error messages...")
      .setRequired(true)
      .setMinLength(15)
      .setMaxLength(1000);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(subjectInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(categoryInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
    );

    await interaction.showModal(modal);
  }
}
