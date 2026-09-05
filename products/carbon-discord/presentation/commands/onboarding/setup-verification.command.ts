import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class SetupVerificationCommand extends Command {
  readonly meta: CommandMeta = {
    name: "setup-verification",
    description: "Post the Carbon Native verification and onboarding panel to this channel",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        content: "You need Administrator permissions to deploy the verification panel.",
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Carbon Native Verification & Access")
      .setColor(0x00e599)
      .setDescription(
        "Welcome to the **Carbon Native Community**!\n\n" +
          "To keep our developer community safe, spam-free, and raid-resistant, all members must complete verification.\n\n" +
          "### Verification Options:\n" +
          "1. **Quick Community Verification**\n" +
          "Click **Agree to Rules & Verify** below. Your account must be at least 3 days old.\n\n" +
          "2. **Carbon Cloud Identity Verification**\n" +
          "Click **Link Carbon Identity** to link your Carbon Cloud API token (`cc_...`) for instant access and the **@Carbon Developer** role.\n\n" +
          "Please abide by the Code of Conduct and treat fellow developers with respect.",
      )
      .setFooter({ text: "Carbon Native Security • Anti-Raid Shield Active" })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("verify:rules")
        .setLabel("Agree to Rules & Verify")
        .setStyle(ButtonStyle.Success)
        .setEmoji("✅"),
      new ButtonBuilder()
        .setCustomId("verify:identity-prompt")
        .setLabel("Link Carbon Identity")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("⚡"),
    );

    if (interaction.channel && "send" in interaction.channel) {
      await (interaction.channel as unknown as { send: (options: unknown) => Promise<unknown> }).send({
        embeds: [embed],
        components: [row],
      });
    }

    await interaction.reply({
      content: "Verification panel deployed successfully.",
      ephemeral: true,
    });
  }
}
