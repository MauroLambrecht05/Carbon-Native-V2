import {
  ChannelType,
  EmbedBuilder,
  Events,
  type Message,
  type MessageReaction,
  type TextChannel,
  type User,
} from "discord.js";
import { BotEvent, type EventMeta } from "../../framework/event.ts";

export class StarboardEvent extends BotEvent {
  readonly meta: EventMeta = { name: Events.MessageReactionAdd };
  private static readonly postedMessages = new Set<string>();

  async handle(...args: unknown[]): Promise<void> {
    const [reaction, user] = args as [MessageReaction, User];
    if (!reaction || !reaction.message) return;

    // Only respond to star reactions
    if (reaction.emoji.name !== "⭐") return;

    const threshold = Number(process.env.STARBOARD_THRESHOLD) || 3;
    if ((reaction.count || 0) < threshold) return;

    const message = reaction.message as Message;
    if (StarboardEvent.postedMessages.has(message.id)) return;

    const guild = message.guild;
    if (!guild) return;

    const starboardChannelId = process.env.STARBOARD_CHANNEL_ID;
    let targetChannel: TextChannel | undefined;

    if (starboardChannelId) {
      targetChannel = guild.channels.cache.get(starboardChannelId) as TextChannel | undefined;
    } else {
      targetChannel = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          (c.name.includes("starboard") || c.name.includes("hall-of-fame") || c.name.includes("showcase")),
      ) as TextChannel | undefined;
    }

    if (!targetChannel || !("send" in targetChannel)) return;

    // Mark as posted to prevent duplicate entries
    StarboardEvent.postedMessages.add(message.id);

    const embed = new EmbedBuilder()
      .setTitle("⭐ Showcase Highlight")
      .setColor(0xffac33)
      .setDescription(message.content || "*[Attachment or Embed]*")
      .addFields(
        { name: "Author", value: `<@${message.author?.id}>`, inline: true },
        { name: "Channel", value: `<#${message.channel.id}>`, inline: true },
        { name: "Stars", value: `⭐ **${reaction.count}**`, inline: true },
        { name: "Source", value: `[Jump to Original Message](${message.url})`, inline: false },
      )
      .setFooter({ text: "Carbon Native Showcase" })
      .setTimestamp(message.createdAt);

    if (message.attachments && message.attachments.size > 0) {
      const firstAttachment = message.attachments.first();
      if (firstAttachment?.contentType?.startsWith("image/")) {
        embed.setImage(firstAttachment.url);
      }
    }

    await targetChannel.send({ embeds: [embed] });
  }

  static clearCache(): void {
    StarboardEvent.postedMessages.clear();
  }
}
