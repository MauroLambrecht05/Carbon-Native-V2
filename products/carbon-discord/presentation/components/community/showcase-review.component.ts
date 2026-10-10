import { EmbedBuilder, type MessageComponentInteraction, type TextChannel } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { ShowcaseStore } from "../../../infrastructure/state/showcase-store.ts";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { requireStaff } from "../../security/authorization.ts";

export class ShowcaseReviewComponent extends Component {
  readonly meta: ComponentMeta = { customId: "showcase:", isPrefix: true };
  private readonly store = new ShowcaseStore();

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const [, action, sourceMessageId] = interaction.customId.split(":");
    if ((action !== "approve" && action !== "reject") || !sourceMessageId) {
      await interaction.reply({ content: "Invalid showcase review action.", ephemeral: true });
      return;
    }
    if (!(await requireStaff(interaction, "community", `showcase.${action}`))) return;
    const status = action === "approve" ? "approved" : "rejected";
    if (!this.store.review(sourceMessageId, status, interaction.user.id)) {
      await interaction.reply({ content: "This nomination has already been reviewed.", ephemeral: true });
      return;
    }

    const sourceEmbed = interaction.message.embeds[0];
    if (action === "approve") {
      const showcaseChannelId = process.env.SHOWCASE_CHANNEL_ID?.trim();
      const channel = showcaseChannelId ? await interaction.guild?.channels.fetch(showcaseChannelId) as TextChannel | null : null;
      if (!channel || !("send" in channel) || !sourceEmbed) {
        await interaction.reply({ content: "The showcase channel is not configured; the nomination remains approved in the audit trail.", ephemeral: true });
        return;
      }
      const published = EmbedBuilder.from(sourceEmbed).setTitle("Carbon community showcase").setColor(0x00e599).setFooter({ text: "Curated by the Carbon community team" });
      await channel.send({ embeds: [published], allowedMentions: { parse: [] } });
    }
    if (sourceEmbed) {
      const reviewed = EmbedBuilder.from(sourceEmbed).setFooter({ text: `${status} by ${interaction.user.tag}` });
      await interaction.update({ embeds: [reviewed], components: [] });
    } else {
      await interaction.reply({ content: `Nomination ${status}.`, ephemeral: true });
    }
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id, action: `showcase.${action}`, targetId: sourceMessageId, outcome: "allowed" });
  }
}
