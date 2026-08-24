import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { PingCommand } from "../../../presentation/commands/diagnostics/ping.command.ts";

describe("PingCommand", () => {
  test("replies with Pong!", async () => {
    const reply = mock(() => Promise.resolve());
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await new PingCommand().execute(interaction);

    expect(reply).toHaveBeenCalledWith("Pong!");
  });
});
