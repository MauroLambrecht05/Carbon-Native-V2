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

export class IssueCreateModal extends Modal {
  readonly meta: ModalMeta = { customId: "modal:issue-create" };

  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const title = interaction.fields.getTextInputValue("issue-title").trim();
    const component = interaction.fields.getTextInputValue("issue-component").trim();
    const env = interaction.fields.getTextInputValue("issue-env").trim();
    const details = interaction.fields.getTextInputValue("issue-details").trim();

    const issueId = `CB-${Math.floor(1000 + Math.random() * 9000)}`;

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
    });

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

    await (targetChannel as unknown as { send: (options: unknown) => Promise<unknown> }).send({
      embeds: [embed],
      components: [actions],
    });

    await interaction.reply({
      content: `🐛 **Issue Logged!** Registered as **${issueId}** in <#${targetChannel.id}>.`,
      ephemeral: true,
    });
  }
}
