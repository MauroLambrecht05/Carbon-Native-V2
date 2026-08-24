import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { StatusCommand, formatDuration } from "../../../presentation/commands/diagnostics/status.command.ts";

function fakeInteraction(ping: number, uptimeMs: number, guildCount: number): ChatInputCommandInteraction {
  return {
    reply: mock(() => Promise.resolve()),
    client: {
      ws: { ping },
      uptime: uptimeMs,
      guilds: { cache: { size: guildCount } },
    },
  } as unknown as ChatInputCommandInteraction;
}

describe("StatusCommand", () => {
  test("replies with an embed reporting live gateway ping, uptime and server count", async () => {
    const interaction = fakeInteraction(42, 3_725_000, 3);

    await new StatusCommand().execute(interaction);

    const reply = interaction.reply as unknown as ReturnType<typeof mock>;
    expect(reply).toHaveBeenCalledTimes(1);
    const [{ embeds }] = reply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    const data = embeds[0].data;

    expect(data.fields).toContainEqual({ name: "Gateway ping", value: "42ms", inline: true });
    expect(data.fields).toContainEqual({ name: "Uptime", value: "1h 2m", inline: true });
    expect(data.fields).toContainEqual({ name: "Servers", value: "3", inline: true });
  });

  test("shows a placeholder before the first heartbeat lands (ping is -1)", async () => {
    const interaction = fakeInteraction(-1, 0, 1);

    await new StatusCommand().execute(interaction);

    const reply = interaction.reply as unknown as ReturnType<typeof mock>;
    const [{ embeds }] = reply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    expect(embeds[0].data.fields).toContainEqual({ name: "Gateway ping", value: "calculating…", inline: true });
  });
});

describe("formatDuration", () => {
  test("renders days, hours and minutes, dropping smaller units once bigger ones are present", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
    expect(formatDuration(90_061_000)).toBe("1d 1h 1m");
  });
});
