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

export class SuggestCreateModal extends Modal {
  readonly meta: ModalMeta = { customId: "modal:suggest-create" };

  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const title = interaction.fields.getTextInputValue("suggest-title").trim();
    const details = interaction.fields.getTextInputValue("suggest-details").trim();

    let targetChannel = interaction.channel as TextChannel | null;
    const configuredChannelId = process.env.SUGGESTIONS_CHANNEL_ID;

    if (configuredChannelId && interaction.guild) {
      const fetched = await interaction.guild.channels.fetch(configuredChannelId);
      if (fetched && fetched.type === ChannelType.GuildText) {
        targetChannel = fetched as TextChannel;
      }
    }

    if (!targetChannel || !("send" in targetChannel)) {
      await interaction.reply({
        content: "Could not locate a text channel to post the suggestion.",
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`💡 ${title}`)
      .setColor(0xffcc00)
      .setDescription(details)
      .addFields(
        { name: "Author", value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: "Status", value: "🟡 **Under Community Discussion**", inline: true },
        { name: "Community Votes", value: "Score: `0` (👍 0 • 👎 0)", inline: false },
      )
      .setFooter({ text: "Carbon Community Feedback • Vote or discuss below" })
      .setTimestamp();

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("suggest:vote:up")
        .setLabel("0")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("👍"),
      new ButtonBuilder()
        .setCustomId("suggest:vote:down")
        .setLabel("0")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("👎"),
    );

    const message = await (targetChannel as unknown as { send: (options: unknown) => Promise<{ id: string }> }).send({
      embeds: [embed],
      components: [actionRow],
    });

    await interaction.reply({
      content: `💡 **Suggestion Submitted!** Your proposal has been posted for voting: <#${targetChannel.id}>`,
      ephemeral: true,
    });
  }
}
