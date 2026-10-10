import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EmbedBuilder, PermissionsBitField, type MessageComponentInteraction } from "discord.js";
import { ShowcaseStore } from "../../../infrastructure/state/showcase-store.ts";
import { ShowcaseReviewComponent } from "../../../presentation/components/community/showcase-review.component.ts";

describe("ShowcaseReviewComponent", () => {
  const store = new ShowcaseStore();
  beforeEach(() => {
    store.clear();
    store.nominate("guild-1", "source-1");
    process.env.SHOWCASE_CHANNEL_ID = "showcase-channel";
  });
  afterEach(() => { delete process.env.SHOWCASE_CHANNEL_ID; });

  test("publishes a staff-approved nomination", async () => {
    const showcase = { send: mock(() => Promise.resolve()) };
    const update = mock(() => Promise.resolve());
    const interaction = {
      customId: "showcase:approve:source-1",
      guildId: "guild-1",
      user: { id: "staff-1", tag: "staff#1" },
      memberPermissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator),
      guild: { channels: { fetch: mock(() => Promise.resolve(showcase)) } },
      message: { embeds: [new EmbedBuilder().setTitle("Showcase nomination").setDescription("A real project")] },
      update,
      reply: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;
    await new ShowcaseReviewComponent().execute(interaction);
    expect(showcase.send).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array), allowedMentions: { parse: [] } }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
});
