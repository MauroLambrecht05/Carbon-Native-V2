import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  type ChatInputCommandInteraction,
} from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";

export class TicketPanelCommand extends Command {
  readonly meta: CommandMeta = {
    name: "ticket-panel",
    description: "Deploy the Carbon Native support ticket panel to this channel",
  };

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({
        content: "You need Administrator permissions to deploy the ticket panel.",
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("🎫 Carbon Native Support & Inquiries")
      .setColor(0x5865f2)
      .setDescription(
        "Need help with **Carbon Native**, build pipelines, cloud orchestration, or plugins?\n\n" +
          "Click **Open Support Ticket** below to start a private conversation with the Carbon team.\n\n" +
          "• **Cloud & Infrastructure**: Build workers, API keys, organization accounts\n" +
          "• **Plugin Development**: Zig C-ABI extension points, FlatBuffers schemas\n" +
          "• **General Support**: Tooling questions, bug reports, and contributions\n\n" +
          "*Please do not share sensitive secrets, passwords, or private keys.*",
      )
      .setFooter({ text: "Carbon Native Support Hub" })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket:open")
        .setLabel("Open Support Ticket")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📩"),
    );

    if (interaction.channel && "send" in interaction.channel) {
      await (interaction.channel as unknown as { send: (options: unknown) => Promise<unknown> }).send({
        embeds: [embed],
        components: [row],
      });
    }

    await interaction.reply({
      content: "Support ticket panel deployed successfully.",
      ephemeral: true,
    });
  }
}
