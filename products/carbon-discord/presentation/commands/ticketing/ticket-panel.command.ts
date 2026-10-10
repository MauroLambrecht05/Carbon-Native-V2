import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type ChatInputCommandInteraction } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Command, type CommandMeta } from "../../framework/command.ts";
import { requireStaff } from "../../security/authorization.ts";

export class TicketPanelCommand extends Command {
  readonly meta: CommandMeta = { name: "ticket-panel", description: "Deploy the private Carbon support panel" };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireStaff(interaction, "support", "ticket.panel.deploy"))) return;
    if (!interaction.channel || !("send" in interaction.channel)) {
      await interaction.reply({ content: "The support panel requires a server text channel.", ephemeral: true });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle("Private Carbon support")
      .setColor(0x5865f2)
      .setDescription(
        "Use the public help forum for general questions so answers help everyone. Open a private request here for account, security, or confidential operational questions.\n\n" +
        "Do not share credentials, private keys, customer data, or unredacted confidential logs.",
      )
      .setFooter({ text: "One open private request per member" });
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("ticket:open").setLabel("Open private support request").setStyle(ButtonStyle.Primary).setEmoji("📩"),
    );
    await interaction.channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user?.id ?? "unknown", action: "ticket.panel.deploy", targetId: interaction.channelId, outcome: "allowed" });
    await interaction.reply({ content: "Private support panel deployed.", ephemeral: true });
  }
}
