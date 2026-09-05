import type { ChatInputCommandInteraction, ThreadChannel } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class ResolveThreadCommand extends Command {
  readonly meta: CommandMeta = {
    name: "resolve",
    description: "Mark this help thread as resolved, rename with [SOLVED], and archive",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const thread = interaction.channel as ThreadChannel | null;
    if (!thread || !thread.isThread()) {
      await interaction.reply({
        content: "The `/resolve` command can only be used inside a thread.",
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
