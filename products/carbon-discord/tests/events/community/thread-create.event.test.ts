import { describe, expect, mock, test } from "bun:test";
import type { ThreadChannel } from "discord.js";
import { ThreadCreateEvent } from "../../../presentation/events/community/thread-create.event.ts";

describe("ThreadCreateEvent", () => {
  test("sends guidance message with resolve button inside new thread", async () => {
    const event = new ThreadCreateEvent();

    const mockThread = {
      isThread: () => true,
      send: mock(() => Promise.resolve()),
    } as unknown as ThreadChannel;

    await event.handle(mockThread, true);

    expect(mockThread.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "💡 Carbon Native Troubleshooting & Help",
            }),
          }),
        ]),
        components: expect.any(Array),
      }),
    );
  });
});
