import type { MessageComponentInteraction, ThreadChannel } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export class TicketCloseComponent extends Component {
  readonly meta: ComponentMeta = { customId: "ticket:close" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const thread = interaction.channel as ThreadChannel | null;
    if (!thread || !thread.isThread()) {
      await interaction.reply({
        content: "This action can only be performed inside a ticket thread.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "Closing and archiving this ticket...",
    });

    await thread.send({
      content: `🔒 **Ticket Closed** by <@${interaction.user.id}>. Thank you for contacting Carbon Native support.`,
    });

    if (thread.setLocked && thread.setArchived) {
      try {
        await thread.setLocked(true);
        await thread.setArchived(true);
      } catch (err) {
        console.warn("Failed to lock/archive thread:", err);
      }
    }
  }
}
