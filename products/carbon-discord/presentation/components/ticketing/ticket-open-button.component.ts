import type { MessageComponentInteraction } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { buildTicketModal } from "../../support/ticket-modal.ts";

export class TicketOpenButtonComponent extends Component {
  readonly meta: ComponentMeta = { customId: "ticket:open" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    await interaction.showModal(buildTicketModal());
  }
}
