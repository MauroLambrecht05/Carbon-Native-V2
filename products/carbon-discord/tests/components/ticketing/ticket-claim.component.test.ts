import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { TicketClaimComponent } from "../../../presentation/components/ticketing/ticket-claim.component.ts";

describe("TicketClaimComponent", () => {
  test("claims the ticket when run inside a thread", async () => {
    const component = new TicketClaimComponent();

    const mockThread = {
      isThread: () => true,
      send: mock(() => Promise.resolve()),
    };

    const interaction = {
      customId: "ticket:claim",
      user: { id: "staff-999" },
      channel: mockThread,
      reply: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(mockThread.send).toHaveBeenCalledWith({
      content: "🙋 <@staff-999> has **claimed** this ticket and will be assisting you.",
    });
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You have successfully claimed this ticket.",
      ephemeral: true,
    });
  });
});
