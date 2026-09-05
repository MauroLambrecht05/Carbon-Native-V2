import { describe, expect, mock, test } from "bun:test";
import type { ModalSubmitInteraction } from "discord.js";
import { SuggestCreateModal } from "../../../presentation/modals/community/suggest-create.modal.ts";

describe("SuggestCreateModal", () => {
  test("creates suggestion card with vote buttons and confirms", async () => {
    const modal = new SuggestCreateModal();

    const mockChannel = {
      id: "channel-sugg",
      send: mock(() => Promise.resolve({ id: "msg-suggest-100" })),
    };

    const interaction = {
      customId: "modal:suggest-create",
      user: { id: "user-456", tag: "developer#1234" },
      channel: mockChannel,
      guild: {
        channels: {
          fetch: mock(() => Promise.resolve(mockChannel)),
        },
      },
      fields: {
        getTextInputValue: mock((field: string) => {
          if (field === "suggest-title") return "Add zero-copy memory mapping for buffers";
          if (field === "suggest-details") return "Currently buffers are copied once when crossing the ABI.";
          return "";
        }),
      },
      reply: mock(() => Promise.resolve()),
    } as unknown as ModalSubmitInteraction;

    await modal.execute(interaction);

    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "💡 Add zero-copy memory mapping for buffers",
            }),
          }),
        ]),
        components: expect.any(Array),
      }),
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("channel-sugg"),
      ephemeral: true,
    });
  });
});
