import type { MessageComponentInteraction, ThreadChannel } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { TicketStore } from "../../../infrastructure/state/ticket-store.ts";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { hasStaffCapability } from "../../security/authorization.ts";

export class TicketCloseComponent extends Component {
  readonly meta: ComponentMeta = { customId: "ticket:close" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const thread = interaction.channel as ThreadChannel | null;
    if (!thread?.isThread()) {
      await interaction.reply({ content: "This action can only be performed inside a support thread.", ephemeral: true });
      return;
    }
    const store = TicketStore.getInstance();
    const ticket = store.get(thread.id);
    const allowed = ticket?.openerId === interaction.user.id || hasStaffCapability(interaction, "support");
    if (!allowed) {
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "ticket.close", targetId: thread.id, outcome: "denied" });
      await interaction.reply({ content: "Only the requester or authorized support staff can close this request.", ephemeral: true });
      return;
    }
    if (ticket?.status === "closed") {
      await interaction.reply({ content: "This support request is already closed.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await thread.send({ content: `🔒 **Support request closed** by <@${interaction.user.id}>.`, allowedMentions: { users: [interaction.user.id] } });
    await thread.setLocked(true);
    await thread.setArchived(true);
    if (ticket) store.close(thread.id);
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "ticket.close", targetId: thread.id, outcome: "allowed" });
    await interaction.editReply("Support request closed and archived.");
  }
}
