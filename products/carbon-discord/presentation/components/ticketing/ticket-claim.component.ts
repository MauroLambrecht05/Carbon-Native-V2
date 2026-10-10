import type { MessageComponentInteraction, ThreadChannel } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { TicketStore } from "../../../infrastructure/state/ticket-store.ts";
import { requireStaff } from "../../security/authorization.ts";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";

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

    if (!(await requireStaff(interaction, "support", "ticket.claim"))) return;
    const result = TicketStore.getInstance().claim(thread.id, interaction.user.id);
    if (result === "already-claimed") {
      await interaction.reply({ content: "This support request has already been claimed.", ephemeral: true });
      return;
    }

    await thread.send({
      content: `🙋 <@${interaction.user.id}> has **claimed** this ticket and will be assisting you.`,
    });
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "ticket.claim", targetId: thread.id, outcome: "allowed" });

    await interaction.reply({
      content: "You have successfully claimed this ticket.",
      ephemeral: true,
    });
  }
}
