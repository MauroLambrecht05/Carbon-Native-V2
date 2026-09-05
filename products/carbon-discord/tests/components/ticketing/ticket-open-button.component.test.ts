import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { TicketOpenButtonComponent } from "../../../presentation/components/ticketing/ticket-open-button.component.ts";

describe("TicketOpenButtonComponent", () => {
  test("presents the support ticket creation modal", async () => {
    const component = new TicketOpenButtonComponent();
    const interaction = {
      customId: "ticket:open",
      showModal: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(interaction.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          custom_id: "modal:ticket-create",
          title: "Open Support Ticket",
        }),
      }),
    );
  });
});
