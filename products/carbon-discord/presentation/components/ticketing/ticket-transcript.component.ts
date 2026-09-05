import {
  AttachmentBuilder,
  type Message,
  type MessageComponentInteraction,
  type ThreadChannel,
} from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export class TicketTranscriptComponent extends Component {
  readonly meta: ComponentMeta = { customId: "ticket:transcript" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const thread = interaction.channel as ThreadChannel | null;
    if (!thread || !thread.isThread()) {
      await interaction.reply({
        content: "This action can only be performed inside a ticket thread.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const messages = await thread.messages.fetch({ limit: 100 });
      const sorted = Array.from(messages.values()).reverse();

      const transcriptLines: string[] = [
        `=============================================================`,
        `CARBON NATIVE SUPPORT TICKET TRANSCRIPT`,
        `Thread: ${thread.name} (${thread.id})`,
        `Generated: ${new Date().toISOString()}`,
        `=============================================================`,
        ``,
      ];

      for (const msg of sorted as Message[]) {
        const time = msg.createdAt.toISOString();
        const author = `${msg.author.tag} (${msg.author.id})`;
        const text = msg.cleanContent || "(embed or attachment)";
        transcriptLines.push(`[${time}] ${author}: ${text}`);
      }

      const fileBuffer = Buffer.from(transcriptLines.join("\n"), "utf-8");
      const attachment = new AttachmentBuilder(fileBuffer, {
        name: `transcript-${thread.name}.txt`,
      });

      await interaction.followUp({
        content: "📄 Here is the transcript for this ticket thread:",
        files: [attachment],
        ephemeral: true,
      });
    } catch (err) {
      await interaction.followUp({
        content: `Failed to export transcript: ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      });
    }
  }
}
