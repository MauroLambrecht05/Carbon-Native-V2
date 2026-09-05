import type { MessageComponentInteraction, ThreadChannel } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export class TicketClaimComponent extends Component {
  readonly meta: ComponentMeta = { customId: "ticket:claim" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const thread = interaction.channel as ThreadChannel | null;
    if (!thread || !thread.isThread()) {
      await interaction.reply({
        content: "This action can only be performed inside a ticket thread.",
        ephemeral: true,
      });
      return;
    }

    await thread.send({
      content: `🙋 <@${interaction.user.id}> has **claimed** this ticket and will be assisting you.`,
    });

    await interaction.reply({
      content: "You have successfully claimed this ticket.",
      ephemeral: true,
    });
  }
}
