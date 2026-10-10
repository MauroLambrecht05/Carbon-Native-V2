import { describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type MessageComponentInteraction } from "discord.js";
import { TicketCloseComponent } from "../../../presentation/components/ticketing/ticket-close.component.ts";

describe("TicketCloseComponent", () => {
  test("locks and archives the thread upon closure", async () => {
    const component = new TicketCloseComponent();

    const mockThread = {
      isThread: () => true,
      id: "thread-close",
      send: mock(() => Promise.resolve()),
      setLocked: mock(() => Promise.resolve()),
      setArchived: mock(() => Promise.resolve()),
    };

    const interaction = {
      customId: "ticket:close",
      user: { id: "staff-999" },
      memberPermissions: new PermissionsBitField(PermissionsBitField.Flags.Administrator),
      channel: mockThread,
      reply: mock(() => Promise.resolve()),
      deferReply: mock(() => Promise.resolve()),
      editReply: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(mockThread.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Support request closed") }));
    expect(mockThread.setLocked).toHaveBeenCalledWith(true);
    expect(mockThread.setArchived).toHaveBeenCalledWith(true);
  });
});
