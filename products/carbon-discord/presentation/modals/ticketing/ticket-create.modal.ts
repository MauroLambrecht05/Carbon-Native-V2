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

export class TicketCreateModal extends Modal {
  readonly meta: ModalMeta = { customId: "modal:ticket-create" };

  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const subject = interaction.fields.getTextInputValue("ticket-subject").trim();
    const category =
      interaction.fields.getTextInputValue("ticket-category")?.trim() || "General Support";
    const description = interaction.fields.getTextInputValue("ticket-description").trim();

    const channel = interaction.channel as TextChannel | null;
    if (!channel || !("threads" in channel)) {
      await interaction.reply({
        content: "Tickets can only be opened within a text channel that supports threads.",
        ephemeral: true,
      });
      return;
    }

    const cleanUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const threadName = `ticket-${cleanUsername}-${Date.now().toString().slice(-4)}`;

    let thread;
    try {
      thread = await channel.threads.create({
        name: threadName,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 1440,
        reason: `Support ticket requested by ${interaction.user.tag}`,
      });
    } catch {
      // If server level doesn't support private threads, fallback to public thread
      thread = await channel.threads.create({
        name: threadName,
        type: ChannelType.PublicThread,
        autoArchiveDuration: 1440,
        reason: `Support ticket requested by ${interaction.user.tag}`,
      });
    }

    try {
      await thread.members.add(interaction.user.id);
    } catch (err) {
      console.warn("Could not explicitly add member to thread:", err);
    }

    const ticketEmbed = new EmbedBuilder()
      .setTitle(`🎫 ${subject}`)
      .setColor(0x00e599)
      .setDescription(description)
      .addFields(
        { name: "Opened By", value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
        { name: "Category", value: category, inline: true },
        { name: "Status", value: "🟡 **Open**", inline: true },
      )
      .setFooter({ text: "Carbon Native Support Thread • Click Claim to take ownership" })
      .setTimestamp();

    const ticketActions = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket:claim")
        .setLabel("Claim Ticket")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🙋"),
      new ButtonBuilder()
        .setCustomId("ticket:close")
        .setLabel("Close Ticket")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🔒"),
      new ButtonBuilder()
        .setCustomId("ticket:transcript")
        .setLabel("Export Transcript")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("📄"),
    );

    await thread.send({
      content: `Hello <@${interaction.user.id}>! A staff member will be with you shortly.`,
      embeds: [ticketEmbed],
      components: [ticketActions],
    });

    await interaction.reply({
      content: `🎫 **Ticket Created!** Your support thread has been opened: <#${thread.id}>`,
      ephemeral: true,
    });
  }
}
