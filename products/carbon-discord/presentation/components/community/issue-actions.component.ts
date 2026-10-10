import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageComponentInteraction } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { IssueStore, type CommunityIssue } from "../../commands/community/issue-store.ts";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { requireStaff } from "../../security/authorization.ts";

const ACTIONS: Readonly<Record<string, { status: CommunityIssue["status"]; label: string; color: number }>> = {
  confirm: { status: "Confirmed", label: "Confirmed bug", color: 0xff4444 },
  info: { status: "Needs Info", label: "Needs more information", color: 0xffaa00 },
  resolve: { status: "Resolved", label: "Resolved", color: 0x00e599 },
};

export class IssueActionsComponent extends Component {
  readonly meta: ComponentMeta = { customId: "issue:", isPrefix: true };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const [, action, issueId] = interaction.customId.split(":");
    const transition = action ? ACTIONS[action] : undefined;
    if (!transition || !issueId) {
      await interaction.reply({ content: "Invalid or expired issue action.", ephemeral: true });
      return;
    }
    if (!(await requireStaff(interaction, "moderation", `issue.${action}`))) return;
    if (!IssueStore.getInstance().updateStatus(issueId, transition.status)) {
      await interaction.reply({ content: "That issue no longer exists in the Carbon issue index.", ephemeral: true });
      return;
    }
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: `issue.${action}`, targetId: issueId, outcome: "allowed" });

    const originalEmbed = interaction.message.embeds[0];
    if (!originalEmbed) {
      await interaction.reply({ content: `Issue **${issueId}** is now **${transition.status}**.`, ephemeral: true });
      return;
    }
    const updatedEmbed = EmbedBuilder.from(originalEmbed).setColor(transition.color);
    updatedEmbed.setFields((originalEmbed.fields ?? []).map((field) =>
      field.name === "Status" ? { name: "Status", value: transition.label, inline: true } : field,
    ));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`issue:confirm:${issueId}`).setLabel("Confirm").setStyle(ButtonStyle.Danger).setDisabled(action === "confirm"),
      new ButtonBuilder().setCustomId(`issue:info:${issueId}`).setLabel("Needs info").setStyle(ButtonStyle.Secondary).setDisabled(action === "info"),
      new ButtonBuilder().setCustomId(`issue:resolve:${issueId}`).setLabel("Resolve").setStyle(ButtonStyle.Success).setDisabled(action === "resolve"),
    );
    await interaction.update({ embeds: [updatedEmbed], components: [row] });
  }
}
