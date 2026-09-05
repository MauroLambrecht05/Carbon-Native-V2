import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class SetupRolesCommand extends Command {
  readonly meta: CommandMeta = {
    name: "setup-roles",
    description: "Deploy the self-service role & notification picker panel",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        content: "You need Administrator permissions to deploy the role picker panel.",
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("🏷️ Carbon Native Roles & Notification Preferences")
      .setColor(0x00e599)
      .setDescription(
        "Customize your server notifications, operating system badges, and language interests!\n\n" +
          "**Click any button below to toggle the role on or off.**\n\n" +
          "🔔 **Notification Pings**: Get notified for major announcements, new releases, or community events.\n" +
          "💻 **Platform Badges**: Connect with developers on your target OS.\n" +
          "⚡ **Tech Stacks**: Share your language expertise and interests.",
      )
      .setFooter({ text: "Carbon Community Role Hub • Click a button to toggle" })
      .setTimestamp();

    const notifyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("role:toggle:Announcements")
        .setLabel("Announcements")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🔔"),
      new ButtonBuilder()
        .setCustomId("role:toggle:Releases")
        .setLabel("Releases")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🚀"),
      new ButtonBuilder()
        .setCustomId("role:toggle:Events")
        .setLabel("Events")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("📅"),
    );

    const platformRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("role:toggle:Windows")
        .setLabel("Windows")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🪟"),
      new ButtonBuilder()
        .setCustomId("role:toggle:macOS")
        .setLabel("macOS")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🍎"),
      new ButtonBuilder()
        .setCustomId("role:toggle:Linux")
        .setLabel("Linux")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🐧"),
    );

    const stackRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("role:toggle:Cpp")
        .setLabel("C++ Engine")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("⚡"),
      new ButtonBuilder()
        .setCustomId("role:toggle:Zig")
        .setLabel("Zig Extensions")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🧩"),
      new ButtonBuilder()
        .setCustomId("role:toggle:Rust")
        .setLabel("Rust Systems")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🦀"),
      new ButtonBuilder()
        .setCustomId("role:toggle:TypeScript")
        .setLabel("TypeScript")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("💻"),
    );

    if (interaction.channel && "send" in interaction.channel) {
      await (interaction.channel as unknown as { send: (options: unknown) => Promise<unknown> }).send({
        embeds: [embed],
        components: [notifyRow, platformRow, stackRow],
      });
    }

    await interaction.reply({
      content: "Role picker panel deployed successfully.",
      ephemeral: true,
    });
  }
}
