import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageComponentInteraction,
} from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export class VerifyIdentityButtonComponent extends Component {
  readonly meta: ComponentMeta = { customId: "verify:identity-prompt" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId("modal:verify-identity")
      .setTitle("Link Carbon Identity");

    const tokenInput = new TextInputBuilder()
      .setCustomId("token-input")
      .setLabel("Carbon Cloud API Token")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("cc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
      .setRequired(true)
      .setMinLength(10)
      .setMaxLength(80);

    const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(tokenInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }
}
