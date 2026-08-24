import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { DownloadCommand } from "../../../presentation/commands/release/download.command.ts";

describe("DownloadCommand", () => {
  test("says plainly that there is nothing to download yet", async () => {
    const reply = mock((_content: string) => Promise.resolve());
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await new DownloadCommand().execute(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    const [message] = reply.mock.calls[0];
    expect(message).toContain("isn't packaged for download yet");
  });
});
