import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, type Message, type MessageReaction, type TextChannel, type User } from "discord.js";
import { ShowcaseStore } from "../../../infrastructure/state/showcase-store.ts";
import { safeUserText } from "../../security/content.ts";
import { BotEvent, type EventMeta } from "../../framework/event.ts";

export class StarboardEvent extends BotEvent {
  readonly meta: EventMeta = { name: Events.MessageReactionAdd };
  private static readonly store = new ShowcaseStore();

  async handle(...args: unknown[]): Promise<void> {
    const [incomingReaction, user] = args as [MessageReaction, User];
    if (!incomingReaction || user?.bot) return;
    const reaction = incomingReaction.partial ? await incomingReaction.fetch() : incomingReaction;
    if (reaction.emoji.name !== "⭐" || (reaction.count ?? 0) < (Number(process.env.SHOWCASE_NOMINATION_THRESHOLD) || 3)) return;
    const incomingMessage = reaction.message;
    const message = (incomingMessage.partial ? await incomingMessage.fetch() : incomingMessage) as Message;
    if (!message.guild || message.author.bot) return;

    const reviewChannelId = process.env.SHOWCASE_REVIEW_CHANNEL_ID?.trim();
    if (!reviewChannelId) return;
    const reviewChannel = await message.guild.channels.fetch(reviewChannelId) as TextChannel | null;
    if (!reviewChannel || !("send" in reviewChannel)) return;
    if (!StarboardEvent.store.nominate(message.guild.id, message.id)) return;

    const embed = new EmbedBuilder()
      .setTitle("Showcase nomination")
      .setColor(0xffac33)
      .setDescription(safeUserText(message.content || "[Attachment or embed]", 4_000))
      .addFields(
        { name: "Author", value: `<@${message.author.id}>`, inline: true },
        { name: "Source channel", value: `<#${message.channel.id}>`, inline: true },
        { name: "Community stars", value: String(reaction.count ?? 0), inline: true },
        { name: "Source", value: `[Review the original message](${message.url})` },
      )
      .setFooter({ text: "Pending staff review" })
      .setTimestamp(message.createdAt);
    const image = message.attachments.find((attachment) => attachment.contentType?.startsWith("image/"));
    if (image) embed.setImage(image.url);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`showcase:approve:${message.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`showcase:reject:${message.id}`).setLabel("Reject").setStyle(ButtonStyle.Secondary),
    );
    const reviewMessage = await reviewChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    StarboardEvent.store.linkReviewMessage(message.id, reviewMessage.id);
  }

  static clearCache(): void {
    this.store.clear();
  }
}
