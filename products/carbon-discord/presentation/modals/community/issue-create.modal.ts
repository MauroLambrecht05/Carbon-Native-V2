import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import { Modal, type ModalMeta } from "../../framework/modal.ts";
import { IssueStore } from "../../commands/community/issue-store.ts";
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { safeUserText } from "../../security/content.ts";
import { consumeRateLimit } from "../../../infrastructure/state/rate-limit.ts";

export class IssueCreateModal extends Modal {
  readonly meta: ModalMeta = { customId: "modal:issue-create" };

  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId ?? interaction.guild?.id ?? "unknown";
    if (!consumeRateLimit(guildId, interaction.user.id, "issue.create", { limit: 5, windowMs: 60 * 60_000 })) {
      await interaction.reply({ content: "You have submitted several reports recently. Please wait before creating another.", ephemeral: true });
      return;
    }
    const title = safeUserText(interaction.fields.getTextInputValue("issue-title"), 100);
    const component = safeUserText(interaction.fields.getTextInputValue("issue-component"), 50);
    const env = safeUserText(interaction.fields.getTextInputValue("issue-env"), 60);
    const details = safeUserText(interaction.fields.getTextInputValue("issue-details"), 1_000);

    const issueId = `CB-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;

    let targetChannel = interaction.channel as TextChannel | null;
    const configuredChannelId = process.env.ISSUES_CHANNEL_ID;

    if (configuredChannelId && interaction.guild) {
      const fetched = await interaction.guild.channels.fetch(configuredChannelId);
      if (fetched && fetched.type === ChannelType.GuildText) {
        targetChannel = fetched as TextChannel;
      }
    }

    if (!targetChannel || !("send" in targetChannel)) {
      await interaction.reply({
        content: "Could not locate a channel to post the issue report.",
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🐛 [${issueId}] ${title}`)
      .setColor(0xed4245)
      .setDescription(details)
      .addFields(
        { name: "Component", value: component, inline: true },
        { name: "Environment", value: env, inline: true },
        { name: "Status", value: "🟡 **Open / Unconfirmed**", inline: true },
        { name: "Reported By", value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
      )
      .setFooter({ text: "Carbon Community Bug Tracker • Staff review controls below" })
      .setTimestamp();

    const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`issue:confirm:${issueId}`)
        .setLabel("Confirm Bug")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId(`issue:info:${issueId}`)
        .setLabel("Needs Info")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("❓"),
    );

    const message = await (targetChannel as unknown as { send: (options: unknown) => Promise<{ id?: string } | undefined> }).send({
      embeds: [embed],
      components: [actions],
      allowedMentions: { parse: [] },
    });
    IssueStore.getInstance().addIssue({
      id: issueId,
      title,
      component,
      environment: env,
      details,
      authorId: interaction.user.id,
      authorTag: interaction.user.tag,
      status: "Open",
      createdAt: new Date(),
      guildId,
      channelId: targetChannel.id,
      messageId: message?.id,
    });
    recordAudit({
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      action: "issue.create",
      targetId: issueId,
      outcome: "allowed",
      metadata: { component, environment: env },
    });

    await interaction.reply({
      content: `🐛 **Issue Logged!** Registered as **${issueId}** in <#${targetChannel.id}>.`,
      ephemeral: true,
    });
  }
}
