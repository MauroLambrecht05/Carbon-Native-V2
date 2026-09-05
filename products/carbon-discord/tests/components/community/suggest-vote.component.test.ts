import { describe, expect, mock, test, beforeEach } from "bun:test";
import { EmbedBuilder, type MessageComponentInteraction } from "discord.js";
import { SuggestVoteComponent } from "../../../presentation/components/community/suggest-vote.component.ts";
import { SuggestionVoteStore } from "../../../presentation/components/community/suggestion-vote-store.ts";

describe("SuggestVoteComponent", () => {
  beforeEach(() => {
    SuggestionVoteStore.getInstance().clear();
  });

  test("records upvote and updates message with new counts and buttons", async () => {
    const component = new SuggestVoteComponent();

    const sampleEmbed = new EmbedBuilder()
      .setTitle("💡 Sample Suggestion")
      .addFields({ name: "Community Votes", value: "Score: `0` (👍 0 • 👎 0)", inline: false });

    const interaction = {
      customId: "suggest:vote:up",
      user: { id: "user-1" },
      message: {
        id: "msg-sample",
        embeds: [sampleEmbed],
      },
      update: mock(() => Promise.resolve()),
      reply: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );

    const counts = SuggestionVoteStore.getInstance().getCounts("msg-sample");
    expect(counts.upVotes).toBe(1);
    expect(counts.downVotes).toBe(0);
  });
});
