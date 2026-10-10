import { EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { recentAuditEvents, recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { requireStaff } from "../../security/authorization.ts";

export class AuditCommand extends Command {
  readonly meta: CommandMeta = { name: "audit", description: "Review recent Carbon Discord staff and security actions" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireStaff(interaction, "moderation", "audit.read"))) return;
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "audit.read", outcome: "allowed" });
    const events = recentAuditEvents(interaction.guildId ?? "direct-message", 20);
    const description = events.length === 0
      ? "No audit events have been recorded for this server."
      : events.map((event) => {
        const time = Math.floor(event.createdAt.getTime() / 1_000);
        return `• <t:${time}:R> \`${event.outcome}\` **${event.action}** by <@${event.actorId}>${event.targetId ? ` → \`${event.targetId}\`` : ""} · \`${event.id.slice(0, 8)}\``;
      }).join("\n");
    await interaction.reply({ embeds: [new EmbedBuilder().setTitle("Carbon Discord audit trail").setDescription(description).setColor(0x2b7a4b)], ephemeral: true, allowedMentions: { parse: [] } });
  }
}
