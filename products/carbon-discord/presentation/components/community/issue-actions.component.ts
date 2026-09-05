import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageComponentInteraction,
} from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { IssueStore } from "../../commands/community/issue-store.ts";

export class IssueActionsComponent extends Component {
  readonly meta: ComponentMeta = { customId: "issue:", isPrefix: true };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    // format: issue:<action>:<id>
    const action = parts[1];
    const issueId = parts[2];

    if (!action || !issueId) {
      await interaction.reply({ content: "Invalid issue action format.", ephemeral: true });
      return;
    }

    const store = IssueStore.getInstance();
    let newStatus: "Confirmed" | "Needs Info" = "Confirmed";
    let statusText = "🔴 **Confirmed Bug**";
    let color = 0xff4444;

    if (action === "info") {
      newStatus = "Needs Info";
      statusText = "🟠 **Needs More Info**";
      color = 0xffaa00;
    }

    store.updateStatus(issueId, newStatus);

    const originalEmbed = interaction.message.embeds[0];
    if (originalEmbed) {
      const updatedEmbed = EmbedBuilder.from(originalEmbed);
      updatedEmbed.setColor(color);
      const fields = (originalEmbed.fields || []).map((f) => {
        if (f.name === "Status") {
          return { name: "Status", value: statusText, inline: true };
        }
        return f;
      });
      updatedEmbed.setFields(fields);

      const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`issue:confirm:${issueId}`)
          .setLabel("Confirmed")
          .setStyle(newStatus === "Confirmed" ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(newStatus === "Confirmed")
          .setEmoji("✅"),
        new ButtonBuilder()
          .setCustomId(`issue:info:${issueId}`)
          .setLabel("Needs Info")
          .setStyle(newStatus === "Needs Info" ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(newStatus === "Needs Info")
          .setEmoji("❓"),
      );

      if (interaction.update) {
        await interaction.update({
          embeds: [updatedEmbed],
          components: [updatedRow],
        });
        return;
      }
    }

    await interaction.reply({
      content: `Issue **${issueId}** marked as **${newStatus}** by <@${interaction.user.id}>.`,
      ephemeral: true,
    });
  }
}
