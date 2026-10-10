import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { MessageReaction, User } from "discord.js";
import { StarboardEvent } from "../../../presentation/events/community/starboard.event.ts";

describe("StarboardEvent", () => {
  beforeEach(() => {
    StarboardEvent.clearCache();
    process.env.SHOWCASE_REVIEW_CHANNEL_ID = "review-channel";
  });
  afterEach(() => { delete process.env.SHOWCASE_REVIEW_CHANNEL_ID; });

  test("sends a threshold nomination to staff review", async () => {
    const reviewChannel = { send: mock(() => Promise.resolve({ id: "review-message" })) };
    const message = {
      partial: false,
      id: "source-message",
      content: "Built a native terminal emulator with Carbon",
      url: "https://discord.com/channels/1/2/3",
      author: { id: "developer-1", bot: false },
      channel: { id: "source-channel" },
      createdAt: new Date(),
      guild: { id: "guild-1", channels: { fetch: mock(() => Promise.resolve(reviewChannel)) } },
      attachments: { find: () => undefined },
    };
    const reaction = { partial: false, emoji: { name: "⭐" }, count: 3, message } as unknown as MessageReaction;
    await new StarboardEvent().handle(reaction, { id: "member-1", bot: false } as User);
    expect(reviewChannel.send).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ title: "Showcase nomination" }) })]),
      components: expect.any(Array),
      allowedMentions: { parse: [] },
    }));
  });
});
