import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { requireStaff } from "../../security/authorization.ts";

export class SetupVerificationCommand extends Command {
  readonly meta: CommandMeta = { name: "setup-verification", description: "Deploy the community rules acknowledgement panel" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireStaff(interaction, "moderation", "verification.deploy"))) return;
    const embed = new EmbedBuilder()
      .setTitle("Carbon community access")
      .setColor(0x00e599)
      .setDescription(
        "Review the server rules and click **Agree to Rules & Verify**. Account linking is unavailable until Carbon has a secure browser-based authorization flow. Carbon staff will never ask you to paste an API token into Discord.\n\n" +
        "Follow the Code of Conduct and never post credentials, private keys, customer data, or confidential logs.",
      )
      .setFooter({ text: "Carbon Native community safety" });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("verify:rules").setLabel("Agree to Rules & Verify").setStyle(ButtonStyle.Success),
    );
    if (!interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "This panel can only be deployed in a server text channel.", ephemeral: true });
      return;
    }
    await interaction.channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user?.id ?? "unknown", action: "verification.deploy", targetId: interaction.channelId, outcome: "allowed" });
    await interaction.reply({ content: "Community access panel deployed.", ephemeral: true });
  }
}
