import {
  ChannelType,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
  type TextChannel,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { requireStaff } from "../../security/authorization.ts";
import { safeUserText } from "../../security/content.ts";

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
      .addBooleanOption((opt) =>
        opt.setName("confirm").setDescription("Confirm this announcement is ready to publish").setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("ping")
          .setDescription("Audience mention")
          .setRequired(false)
          .addChoices(
            { name: "None", value: "none" },
            { name: "Product announcements", value: "announcements" },
            { name: "Stable releases", value: "releases" },
            { name: "Preview releases", value: "preview" },
            { name: "Security advisories", value: "security" },
            { name: "Events", value: "events" },
            { name: "@everyone (emergencies only)", value: "everyone" },
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
    if (!(await requireStaff(interaction, "community", "announcement.publish"))) return;

    const channelOption = interaction.options.getChannel("channel", true);
    const title = safeUserText(interaction.options.getString("title", true), 256);
    const message = safeUserText(interaction.options.getString("message", true), 4_000);
    const ping = interaction.options.getString("ping") || "none";
    const style = interaction.options.getString("style") || "brand";
    const confirmed = interaction.options.getBoolean("confirm", true);
    if (!confirmed) {
      await interaction.reply({ content: "Announcement cancelled because publication was not confirmed.", ephemeral: true });
      return;
    }

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
      .setTitle(`Announcement: ${title}`)
      .setColor(color)
      .setDescription(message)
      .setFooter({
        text: `Official Carbon announcement | Published by ${authorTag}`,
      })
      .setTimestamp();

    let mentionContent: string | undefined;
    let allowedMentions: { parse: Array<"everyone"> } | { parse: []; roles?: string[] } = { parse: [] };
    if (ping === "everyone") {
      mentionContent = "@everyone";
      allowedMentions = { parse: ["everyone"] };
    } else if (ping !== "none") {
      const envName: Record<string, string> = {
        announcements: "ANNOUNCEMENTS_ROLE_ID",
        releases: "RELEASES_ROLE_ID",
        preview: "PREVIEW_ROLE_ID",
        security: "SECURITY_ROLE_ID",
        events: "EVENTS_ROLE_ID",
      };
      const roleId = process.env[envName[ping]]?.trim();
      if (!roleId || !interaction.guild?.roles.cache.has(roleId)) {
        await interaction.reply({ content: "The selected audience role is not configured in this server.", ephemeral: true });
        return;
      }
      mentionContent = `<@&${roleId}>`;
      allowedMentions = { parse: [], roles: [roleId] };
    }

    await targetChannel.send({
      content: mentionContent,
      embeds: [embed],
      allowedMentions,
    });

    recordAudit({
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      action: "announcement.publish",
      targetId: targetChannel.id,
      outcome: "allowed",
      metadata: { title, ping, style },
    });

    await interaction.reply({
      content: `Announcement successfully broadcast to <#${targetChannel.id}>.`,
      ephemeral: true,
    });
  }
}
