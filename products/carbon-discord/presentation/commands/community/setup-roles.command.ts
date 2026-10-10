import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { requireStaff } from "../../security/authorization.ts";

const PREFERENCES = [
  ["announcements", "Product announcements", "📣"],
  ["releases", "Stable releases", "🚀"],
  ["preview", "Preview releases", "🧪"],
  ["security", "Security advisories", "🛡️"],
  ["events", "Events", "📅"],
] as const;

export class SetupRolesCommand extends Command {
  readonly meta: CommandMeta = { name: "setup-roles", description: "Deploy the notification preference panel" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireStaff(interaction, "community", "preferences.deploy"))) return;
    const embed = new EmbedBuilder()
      .setTitle("Carbon notification preferences")
      .setColor(0x00e599)
      .setDescription("Choose the Carbon updates you want to receive. Click a preference again to turn it off. Security advisories contain security-relevant product notices; they are never promotional.")
      .setFooter({ text: "You can change these preferences at any time" });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...PREFERENCES.map(([key, label, emoji]) => new ButtonBuilder().setCustomId(`role:toggle:${key}`).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Secondary)),
    );
    if (!interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "The preference panel requires a server text channel.", ephemeral: true });
      return;
    }
    await interaction.channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user?.id ?? "unknown", action: "preferences.deploy", targetId: interaction.channelId, outcome: "allowed" });
    await interaction.reply({ content: "Notification preference panel deployed.", ephemeral: true });
  }
}
