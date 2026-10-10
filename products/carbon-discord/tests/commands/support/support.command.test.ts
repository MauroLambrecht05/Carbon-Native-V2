import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { SupportCommand } from "../../../presentation/commands/support/support.command.ts";

describe("SupportCommand", () => {
  test("opens the structured private-support modal in a guild", async () => {
    const showModal = mock(() => Promise.resolve());
    const interaction = { inGuild: () => true, showModal } as unknown as ChatInputCommandInteraction;
    await new SupportCommand().execute(interaction);
    expect(showModal).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ custom_id: "modal:ticket-create" }) }));
  });
});
