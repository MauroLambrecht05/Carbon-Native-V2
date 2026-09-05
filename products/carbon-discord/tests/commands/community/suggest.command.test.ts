import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { SuggestCommand } from "../../../presentation/commands/community/suggest.command.ts";

describe("SuggestCommand", () => {
  test("presents the community suggestion modal", async () => {
    const cmd = new SuggestCommand();
    const interaction = {
      commandName: "suggest",
      showModal: mock(() => Promise.resolve()),
    } as unknown as ChatInputCommandInteraction;

    await cmd.execute(interaction);

    expect(interaction.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          custom_id: "modal:suggest-create",
          title: "Submit Community Suggestion",
        }),
      }),
    );
  });
});
