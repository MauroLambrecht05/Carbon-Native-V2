import type { MessageComponentInteraction, ThreadChannel } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export class ResolveThreadComponent extends Component {
  readonly meta: ComponentMeta = { customId: "thread:resolve" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const thread = interaction.channel as ThreadChannel | null;
    if (!thread || !thread.isThread()) {
      await interaction.reply({
        content: "This action can only be performed inside a thread.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `✅ Thread marked as **RESOLVED** by <@${interaction.user.id}>. Archiving thread...`,
    });

    if (!thread.name.startsWith("[SOLVED]")) {
      try {
        await thread.setName(`[SOLVED] ${thread.name}`.slice(0, 100));
      } catch (err) {
        console.warn("Could not rename thread on resolve:", err);
      }
    }

    try {
      if (thread.setLocked) await thread.setLocked(true);
      if (thread.setArchived) await thread.setArchived(true);
    } catch (err) {
      console.warn("Could not lock/archive thread on resolve:", err);
    }
  }
}
