import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageComponentInteraction,
} from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { SuggestionVoteStore, type VoteType } from "./suggestion-vote-store.ts";

export class SuggestVoteComponent extends Component {
  readonly meta: ComponentMeta = { customId: "suggest:vote:", isPrefix: true };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const isUpvote = interaction.customId === "suggest:vote:up";
    const voteType: VoteType = isUpvote ? "up" : "down";

    const store = SuggestionVoteStore.getInstance();
    const { upVotes, downVotes, userVote } = store.recordVote(
      interaction.message.id,
      interaction.user.id,
      voteType,
    );

    const originalEmbed = interaction.message.embeds[0];
    if (!originalEmbed) {
      await interaction.reply({
        content: `Vote recorded: ${userVote ? `voted ${userVote}` : "vote removed"}.`,
        ephemeral: true,
      });
      return;
    }

    const netScore = upVotes - downVotes;
    const scoreString = `Score: \`${netScore > 0 ? `+${netScore}` : netScore}\` (👍 ${upVotes} • 👎 ${downVotes})`;

    // Reconstruct embed with updated score
    const updatedEmbed = EmbedBuilder.from(originalEmbed);
    const fields = (originalEmbed.fields || []).map((f) => {
      if (f.name === "Community Votes") {
        return { name: "Community Votes", value: scoreString, inline: false };
      }
      return f;
    });
    updatedEmbed.setFields(fields);

    // Reconstruct buttons with updated counts and highlight the user's active choice
    const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("suggest:vote:up")
        .setLabel(String(upVotes))
        .setStyle(userVote === "up" ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setEmoji("👍"),
      new ButtonBuilder()
        .setCustomId("suggest:vote:down")
        .setLabel(String(downVotes))
        .setStyle(userVote === "down" ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setEmoji("👎"),
    );

    if (interaction.update) {
      await interaction.update({
        embeds: [updatedEmbed],
        components: [updatedRow],
      });
    } else {
      await interaction.reply({
        content: `Vote updated (${scoreString})`,
        ephemeral: true,
      });
    }
  }
}
