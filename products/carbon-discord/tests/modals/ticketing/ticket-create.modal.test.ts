import { describe, expect, mock, test } from "bun:test";
import type { ModalSubmitInteraction } from "discord.js";
import { TicketCreateModal } from "../../../presentation/modals/ticketing/ticket-create.modal.ts";

describe("TicketCreateModal", () => {
  test("creates a ticket thread, sends embed with actions, and responds", async () => {
    const modal = new TicketCreateModal();

    const mockThread = {
      id: "thread-789",
      members: {
        add: mock(() => Promise.resolve()),
      },
      send: mock(() => Promise.resolve()),
    };

    const mockChannel = {
      threads: {
        create: mock(() => Promise.resolve(mockThread)),
      },
    };

    const interaction = {
      customId: "modal:ticket-create",
      user: { id: "user-123", username: "devuser", tag: "devuser#0001" },
      channel: mockChannel,
      fields: {
        getTextInputValue: mock((field: string) => {
          if (field === "ticket-subject") return "Build failure on Windows";
          if (field === "ticket-category") return "Cloud";
          if (field === "ticket-description") return "Worker cannot acquire lock on target";
          return "";
        }),
      },
      reply: mock(() => Promise.resolve()),
    } as unknown as ModalSubmitInteraction;

    await modal.execute(interaction);

    expect(mockChannel.threads.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringContaining("ticket-devuser"),
      }),
    );
    expect(mockThread.members.add).toHaveBeenCalledWith("user-123");
    expect(mockThread.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "🎫 Build failure on Windows",
            }),
          }),
        ]),
        components: expect.any(Array),
      }),
    );
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("thread-789"),
      ephemeral: true,
    });
  });
});
