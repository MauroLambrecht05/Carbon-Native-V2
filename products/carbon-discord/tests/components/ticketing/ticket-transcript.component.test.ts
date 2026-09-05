import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { TicketTranscriptComponent } from "../../../presentation/components/ticketing/ticket-transcript.component.ts";

describe("TicketTranscriptComponent", () => {
  test("generates and attaches transcript file", async () => {
    const component = new TicketTranscriptComponent();

    const mockMessages = new Map([
      [
        "msg-1",
        {
          createdAt: new Date("2026-09-03T12:00:00Z"),
          author: { tag: "alice#0001", id: "user-1" },
          cleanContent: "Help, my build crashed!",
        },
      ],
      [
        "msg-2",
        {
          createdAt: new Date("2026-09-03T12:05:00Z"),
          author: { tag: "bob#0002", id: "staff-1" },
          cleanContent: "Could you share the crash stack trace?",
        },
      ],
    ]);

    const mockThread = {
      isThread: () => true,
      name: "ticket-alice-1234",
      id: "thread-555",
      messages: {
        fetch: mock(() => Promise.resolve(mockMessages)),
      },
    };

    const interaction = {
      customId: "ticket:transcript",
      channel: mockThread,
      deferReply: mock(() => Promise.resolve()),
      followUp: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(mockThread.messages.fetch).toHaveBeenCalledWith({ limit: 100 });
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("transcript"),
        files: expect.any(Array),
        ephemeral: true,
      }),
    );
  });
});
