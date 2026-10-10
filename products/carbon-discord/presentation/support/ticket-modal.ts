import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

export function buildTicketModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("modal:ticket-create")
    .setTitle("Open a private support request")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ticket-subject").setLabel("Issue summary").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(5).setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ticket-category").setLabel("Product area").setStyle(TextInputStyle.Short).setPlaceholder("Runtime / CLI / Cloud / Plugins / Other").setRequired(true).setMaxLength(50),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("ticket-description")
          .setLabel("Impact, details, and reproduction steps")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Do not include credentials, private keys, customer data, or confidential logs.")
          .setRequired(true)
          .setMinLength(20)
          .setMaxLength(1_000),
      ),
    );
}
