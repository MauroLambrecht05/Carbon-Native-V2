import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Modal, type ModalMeta } from "../../framework/modal.ts";
import { safeUserText } from "../../security/content.ts";
import { consumeRateLimit } from "../../../infrastructure/state/rate-limit.ts";

export class SuggestCreateModal extends Modal {
  readonly meta: ModalMeta = { customId: "modal:suggest-create" };

  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId ?? interaction.guild?.id ?? "unknown";
    if (!consumeRateLimit(guildId, interaction.user.id, "suggestion.create", { limit: 3, windowMs: 60 * 60_000 })) {
      await interaction.reply({ content: "You have submitted several suggestions recently. Please wait before creating another.", ephemeral: true });
      return;
    }
    const title = safeUserText(interaction.fields.getTextInputValue("suggest-title"), 100);
    const details = safeUserText(interaction.fields.getTextInputValue("suggest-details"), 1_000);
    let targetChannel = interaction.channel as TextChannel | null;
    const configuredChannelId = process.env.SUGGESTIONS_CHANNEL_ID;
    if (configuredChannelId && interaction.guild) {
      const fetched = await interaction.guild.channels.fetch(configuredChannelId);
      if (fetched?.type === ChannelType.GuildText) targetChannel = fetched as TextChannel;
    }
    if (!targetChannel || !("send" in targetChannel)) {
      await interaction.reply({ content: "Could not locate the configured suggestion channel.", ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`💡 ${title}`)
      .setColor(0xffcc00)
      .setDescription(details)
      .addFields(
        { name: "Author", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Status", value: "Under review", inline: true },
        { name: "Community Interest", value: "0 members need this", inline: false },
      )
      .setFooter({ text: "Carbon Community Feedback" })
      .setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("suggest:vote:up").setLabel("I need this too (0)").setStyle(ButtonStyle.Secondary).setEmoji("👍"),
    );
    const message = await targetChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: "suggestion.create", targetId: message.id, outcome: "allowed" });
    await interaction.reply({ content: `Your suggestion was posted in <#${targetChannel.id}> for review.`, ephemeral: true });
  }
}
