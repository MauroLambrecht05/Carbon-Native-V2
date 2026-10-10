import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type MessageComponentInteraction } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";
import { SuggestionVoteStore } from "./suggestion-vote-store.ts";

export class SuggestVoteComponent extends Component {
  readonly meta: ComponentMeta = { customId: "suggest:vote:", isPrefix: true };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    if (interaction.customId !== "suggest:vote:up") {
      await interaction.reply({ content: "This suggestion action has expired.", ephemeral: true });
      return;
    }
    const { upVotes, userVote } = SuggestionVoteStore.getInstance().recordVote(
      interaction.message.id,
      interaction.user.id,
      "up",
      interaction.guildId ?? "unknown",
    );
    const interest = `${upVotes} ${upVotes === 1 ? "member needs" : "members need"} this`;
    const originalEmbed = interaction.message.embeds[0];
    if (!originalEmbed) {
      await interaction.reply({ content: userVote ? "Interest recorded." : "Interest removed.", ephemeral: true });
      return;
    }
    const updatedEmbed = EmbedBuilder.from(originalEmbed);
    updatedEmbed.setFields((originalEmbed.fields ?? []).map((field) =>
      field.name === "Community Votes" || field.name === "Community Interest"
        ? { name: "Community Interest", value: interest, inline: false }
        : field,
    ));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("suggest:vote:up").setLabel(`I need this too (${upVotes})`).setStyle(userVote ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji("👍"),
    );
    await interaction.update({ embeds: [updatedEmbed], components: [row] });
  }
}
