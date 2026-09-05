import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { ResolveThreadCommand } from "../../../presentation/commands/community/resolve-thread.command.ts";

describe("ResolveThreadCommand", () => {
  test("marks thread as solved, renames, and archives", async () => {
    const cmd = new ResolveThreadCommand();

    const mockThread = {
      isThread: () => true,
      name: "linker error on msvc",
      setName: mock(() => Promise.resolve()),
      setLocked: mock(() => Promise.resolve()),
      setArchived: mock(() => Promise.resolve()),
    };

    const interaction = {
      commandName: "resolve",
      user: { id: "user-author" },
      channel: mockThread,
      reply: mock(() => Promise.resolve()),
    } as unknown as ChatInputCommandInteraction;

    await cmd.execute(interaction);

    expect(mockThread.setName).toHaveBeenCalledWith("[SOLVED] linker error on msvc");
    expect(mockThread.setLocked).toHaveBeenCalledWith(true);
    expect(mockThread.setArchived).toHaveBeenCalledWith(true);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("RESOLVED"),
      }),
    );
  });
});
