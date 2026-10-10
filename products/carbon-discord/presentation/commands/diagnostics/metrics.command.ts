import { EmbedBuilder, type ChatInputCommandInteraction, type SlashCommandBuilder } from "discord.js";
import { metricTotals } from "../../../infrastructure/state/metrics.ts";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { requireStaff } from "../../security/authorization.ts";

export class MetricsCommand extends Command {
  readonly meta: CommandMeta = { name: "metrics", description: "Review aggregate Carbon Discord activity" };

  configureBuilder(builder: SlashCommandBuilder): void {
    builder.addIntegerOption((option) => option.setName("days").setDescription("Reporting window in days").setMinValue(1).setMaxValue(365));
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireStaff(interaction, "community", "metrics.read"))) return;
    const days = interaction.options.getInteger("days") ?? 30;
    const totals = metricTotals(interaction.guildId ?? "direct-message", days);
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "metrics.read", outcome: "allowed", metadata: { days } });
    const description = totals.length > 0
      ? totals.map((item) => `• **${item.metric}**: ${item.count.toLocaleString()}`).join("\n")
      : "No aggregate activity has been recorded for this period.";
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle(`Carbon Discord activity · ${days} days`).setDescription(description).setColor(0x2b7a4b).setFooter({ text: "Aggregate counts only; no member profiling" })],
      ephemeral: true,
    });
  }
}
