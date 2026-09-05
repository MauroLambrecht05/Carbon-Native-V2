import {
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
  type TextChannel,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class AnnounceCommand extends Command {
  readonly meta: CommandMeta = {
    name: "announce",
    description: "Broadcast an official announcement to a designated channel",
  };

  configureBuilder(builder: SlashCommandBuilder): void {
    builder
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Target announcement channel")
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      )
      .addStringOption((opt) =>
        opt.setName("title").setDescription("Announcement headline").setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("message").setDescription("Announcement text body").setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("ping")
          .setDescription("Audience mention")
          .setRequired(false)
          .addChoices(
            { name: "None", value: "none" },
            { name: "@everyone", value: "everyone" },
            { name: "@here", value: "here" },
          ),
      )
      .addStringOption((opt) =>
        opt
          .setName("style")
          .setDescription("Visual style and severity")
          .setRequired(false)
          .addChoices(
            { name: "Brand (Emerald)", value: "brand" },
            { name: "Info (Blurple)", value: "info" },
            { name: "Warning (Yellow)", value: "warning" },
            { name: "Critical (Red)", value: "critical" },
          ),
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        content: "You need Administrator permissions to broadcast announcements.",
        ephemeral: true,
      });
      return;
    }

    const channelOption = interaction.options.getChannel("channel", true);
    const title = interaction.options.getString("title", true);
    const message = interaction.options.getString("message", true);
    const ping = interaction.options.getString("ping") || "none";
    const style = interaction.options.getString("style") || "brand";

    let color = 0x00e599; // Brand emerald
    if (style === "info") color = 0x5865f2;
    if (style === "warning") color = 0xfee75c;
    if (style === "critical") color = 0xed4245;

    const targetChannel = interaction.guild?.channels.cache.get(channelOption.id) as
      | TextChannel
      | undefined;

    if (!targetChannel || !("send" in targetChannel)) {
      await interaction.reply({
        content: "The specified channel is not a valid text or announcement channel.",
        ephemeral: true,
      });
      return;
    }

    const authorTag = interaction.user?.tag || "Staff";
    const embed = new EmbedBuilder()
      .setTitle(`📢 ${title}`)
      .setColor(color)
      .setDescription(message)
      .setFooter({
        text: `Official Carbon Announcement • Broadcast by ${authorTag}`,
      })
      .setTimestamp();

    let mentionContent: string | undefined;
    if (ping === "everyone") mentionContent = "@everyone";
    else if (ping === "here") mentionContent = "@here";

    await targetChannel.send({
      content: mentionContent,
      embeds: [embed],
    });

    await interaction.reply({
      content: `Announcement successfully broadcast to <#${targetChannel.id}>.`,
      ephemeral: true,
    });
  }
}
