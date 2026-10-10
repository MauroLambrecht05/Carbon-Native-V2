import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { StatusCommand } from "../../../presentation/commands/diagnostics/status.command.ts";

describe("StatusCommand", () => {
  afterEach(() => { delete process.env.STATUS_URL; });

  test("does not misrepresent bot connectivity as product health", async () => {
    const reply = mock(() => Promise.resolve());
    await new StatusCommand().execute({ reply } as unknown as ChatInputCommandInteraction);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("authoritative public status endpoint"), ephemeral: true }));
  });

  test("links the configured authoritative status page", async () => {
    process.env.STATUS_URL = "https://status.example.com";
    const reply = mock(() => Promise.resolve());
    await new StatusCommand().execute({ reply } as unknown as ChatInputCommandInteraction);
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array), components: expect.any(Array), ephemeral: true }));
  });
});
