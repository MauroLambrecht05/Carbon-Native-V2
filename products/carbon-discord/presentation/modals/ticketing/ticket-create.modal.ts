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
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { TicketStore } from "../../../infrastructure/state/ticket-store.ts";
import { safeUserText } from "../../security/content.ts";
import { consumeRateLimit } from "../../../infrastructure/state/rate-limit.ts";

export class TicketCreateModal extends Modal {
  readonly meta: ModalMeta = { customId: "modal:ticket-create" };

  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const subject = safeUserText(interaction.fields.getTextInputValue("ticket-subject"), 100);
    const category = safeUserText(
      interaction.fields.getTextInputValue("ticket-category") || "General Support",
      50,
    );
    const description = safeUserText(interaction.fields.getTextInputValue("ticket-description"), 1_000);

    const channel = interaction.channel as TextChannel | null;
    if (!channel || !("threads" in channel)) {
      await interaction.reply({
        content: "Tickets can only be opened within a text channel that supports threads.",
        ephemeral: true,
      });
      return;
    }

    const guildId = interaction.guildId ?? interaction.guild?.id ?? "unknown";
    if (!consumeRateLimit(guildId, interaction.user.id, "ticket.create", { limit: 3, windowMs: 24 * 60 * 60_000 })) {
      await interaction.reply({ content: "You have opened several support requests recently. Please continue in an existing request or contact a moderator.", ephemeral: true });
      return;
    }
    const existing = TicketStore.getInstance().findOpenForMember(guildId, interaction.user.id);
    if (existing) {
      await interaction.reply({
        content: `You already have an open support request: <#${existing.threadId}>. Please continue there.`,
        ephemeral: true,
      });
      return;
    }

    const cleanUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24) || "member";
    const threadName = `ticket-${cleanUsername}-${Date.now().toString().slice(-4)}`;

    let thread;
    try {
      thread = await channel.threads.create({
        name: threadName,
        type: ChannelType.PrivateThread,
        autoArchiveDuration: 1440,
        reason: `Support ticket requested by ${interaction.user.tag}`,
      });
    } catch (error) {
      recordAudit({
        guildId,
        actorId: interaction.user.id,
        action: "ticket.create",
        outcome: "failed",
        metadata: { reason: error instanceof Error ? error.message.slice(0, 200) : "private thread creation failed" },
      });
      await interaction.reply({
        content: "I could not create a private support thread. No public fallback was created. Please contact a moderator.",
        ephemeral: true,
      });
      return;
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

    TicketStore.getInstance().create({
      threadId: thread.id,
      guildId,
      openerId: interaction.user.id,
      subject,
      category,
    });
    recordAudit({
      guildId,
      actorId: interaction.user.id,
      action: "ticket.create",
      targetId: thread.id,
      outcome: "allowed",
      metadata: { category },
    });

    await interaction.reply({
      content: `🎫 **Ticket Created!** Your support thread has been opened: <#${thread.id}>`,
      ephemeral: true,
    });
  }
}
