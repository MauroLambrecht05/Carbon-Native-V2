import { describe, expect, mock, test, beforeEach } from "bun:test";
import { ChannelType, type MessageReaction, type User } from "discord.js";
import { StarboardEvent } from "../../../presentation/events/community/starboard.event.ts";

describe("StarboardEvent", () => {
  beforeEach(() => {
    StarboardEvent.clearCache();
  });

  test("posts showcase embed when message receives threshold stars", async () => {
    const event = new StarboardEvent();

    const mockStarboardChannel = {
      type: ChannelType.GuildText,
      name: "starboard",
      send: mock(() => Promise.resolve()),
    };

    const mockGuild = {
      channels: {
        cache: {
          get: mock(() => undefined),
          find: mock((fn: any) => (fn(mockStarboardChannel) ? mockStarboardChannel : undefined)),
        },
      },
    };

    const mockMessage = {
      id: "msg-showcase-1",
      content: "Built a native terminal emulator in Carbon Native!",
      url: "https://discord.com/channels/123/456/msg-showcase-1",
      author: { id: "dev-1", tag: "dev#0001" },
      channel: { id: "chan-showcase" },
      createdAt: new Date(),
      guild: mockGuild,
      attachments: { size: 0, first: () => null },
    };

    const reaction = {
      emoji: { name: "⭐" },
      count: 3,
      message: mockMessage,
    } as unknown as MessageReaction;

    const user = { id: "fan-1" } as User;

    await event.handle(reaction, user);

    expect(mockStarboardChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "⭐ Showcase Highlight",
              description: "Built a native terminal emulator in Carbon Native!",
            }),
          }),
        ]),
      }),
    );
  });
});
