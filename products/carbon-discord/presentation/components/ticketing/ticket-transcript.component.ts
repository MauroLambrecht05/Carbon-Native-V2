import {
  AttachmentBuilder,
  type Message,
  type MessageComponentInteraction,
  type ThreadChannel,
} from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { requireStaff } from "../../security/authorization.ts";
import { safeUserText } from "../../security/content.ts";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";

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

    if (!(await requireStaff(interaction, "support", "ticket.transcript"))) return;

    await interaction.deferReply({ ephemeral: true });

    try {
      const collected = new Map<string, Message>();
      let before: string | undefined;
      while (collected.size < 1_000) {
        const page = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        for (const [id, message] of page) collected.set(id, message as Message);
        if (page.size < 100) break;
        before = page.last()?.id;
        if (!before) break;
      }
      const sorted = Array.from(collected.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

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
        const text = safeUserText(msg.cleanContent || "(embed or attachment)", 4_000);
        const attachments = msg.attachments?.map((attachment) => safeUserText(attachment.url, 2_000)).join(" ") ?? "";
        transcriptLines.push(`[${time}] ${author}: ${text}${attachments ? ` [attachments: ${attachments}]` : ""}`);
      }
      if (collected.size >= 1_000) transcriptLines.push("", "[Transcript capped at the newest 1,000 messages]");

      const fileBuffer = Buffer.from(transcriptLines.join("\n"), "utf-8");
      const attachment = new AttachmentBuilder(fileBuffer, {
        name: `transcript-${thread.name}.txt`,
      });

      await interaction.followUp({
        content: "📄 Here is the transcript for this ticket thread:",
        files: [attachment],
        ephemeral: true,
      });
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "ticket.transcript", targetId: thread.id, outcome: "allowed", metadata: { messageCount: collected.size } });
    } catch (err) {
      await interaction.followUp({
        content: `Failed to export transcript: ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      });
    }
  }
}
