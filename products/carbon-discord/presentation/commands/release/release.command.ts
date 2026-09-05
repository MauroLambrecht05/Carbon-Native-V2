import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class ReleaseCommand extends Command {
  readonly meta: CommandMeta = {
    name: "release",
    description: "Publish a Carbon Native release announcement card",
  };

  configureBuilder(builder: SlashCommandBuilder): void {
    builder
      .addStringOption((opt) =>
        opt.setName("version").setDescription("Version tag (e.g. v2.1.0)").setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName("highlights").setDescription("Key changes and release highlights").setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Distribution channel")
          .setRequired(false)
          .addChoices(
            { name: "Stable", value: "stable" },
            { name: "Canary", value: "canary" },
            { name: "Nightly", value: "nightly" },
          ),
      )
      .addStringOption((opt) =>
        opt.setName("url").setDescription("URL to release notes / GitHub release").setRequired(false),
      );
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        content: "You need Administrator permissions to publish release cards.",
        ephemeral: true,
      });
      return;
    }

    const version = interaction.options.getString("version", true);
    const highlights = interaction.options.getString("highlights", true);
    const releaseChannel = interaction.options.getString("channel") || "stable";
    const releaseUrl =
      interaction.options.getString("url") ||
      `https://github.com/MauroLambrecht05/Carbon-Native-V2/releases/tag/${encodeURIComponent(version)}`;

    const channelEmoji = releaseChannel === "stable" ? "🟢" : releaseChannel === "canary" ? "🟡" : "🟣";

    const embed = new EmbedBuilder()
      .setTitle(`🚀 Carbon Native ${version} Released!`)
      .setColor(0x00e599)
      .setDescription(
        `A new release is available on the **${releaseChannel}** channel.\n\n` +
          `### 🌟 Highlights & Key Changes\n${highlights}\n\n` +
          `### 📦 Quick Upgrade\n\`\`\`sh\ncarbon upgrade\n\`\`\``,
      )
      .addFields(
        {
          name: "Channel",
          value: `${channelEmoji} **${releaseChannel.toUpperCase()}**`,
          inline: true,
        },
        {
          name: "Architectures",
          value: "`x86_64` • `aarch64` (Universal)",
          inline: true,
        },
        {
          name: "Platforms",
          value: "Windows • macOS • Linux",
          inline: true,
        },
      )
      .setFooter({ text: "Carbon Native Polyglot Engine" })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Release Notes")
        .setStyle(ButtonStyle.Link)
        .setURL(releaseUrl)
        .setEmoji("📄"),
      new ButtonBuilder()
        .setLabel("Source Code")
        .setStyle(ButtonStyle.Link)
        .setURL("https://github.com/MauroLambrecht05/Carbon-Native-V2")
        .setEmoji("🐙"),
    );

    if (interaction.channel && "send" in interaction.channel) {
      await (interaction.channel as unknown as { send: (options: unknown) => Promise<unknown> }).send({
        embeds: [embed],
        components: [row],
      });
    }

    await interaction.reply({
      content: `Release announcement for **${version}** posted successfully.`,
      ephemeral: true,
    });
  }
}
