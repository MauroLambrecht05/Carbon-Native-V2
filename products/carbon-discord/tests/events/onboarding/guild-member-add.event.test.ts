import { describe, expect, mock, test, beforeEach, afterEach } from "bun:test";
import { ChannelType, type GuildMember } from "discord.js";
import { GuildMemberAddEvent } from "../../../presentation/events/onboarding/guild-member-add.event.ts";

function fakeMember(accountAgeHours: number): GuildMember {
  const createdTimestamp = Date.now() - accountAgeHours * 60 * 60 * 1000;
  const mockChannel = {
    type: ChannelType.GuildText,
    send: mock(() => Promise.resolve()),
  };

  return {
    id: "user-123",
    user: {
      tag: "TestUser#1234",
      createdTimestamp,
    },
    guild: {
      channels: {
        fetch: mock((id: string) => Promise.resolve(mockChannel)),
      },
    },
  } as unknown as GuildMember;
}

describe("GuildMemberAddEvent", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("flags account younger than threshold and logs to LOG_CHANNEL_ID", async () => {
    process.env.LOG_CHANNEL_ID = "channel-logs";
    const event = new GuildMemberAddEvent();
    const member = fakeMember(5); // 5 hours old, below 72h

    await event.handle(member);

    expect(member.guild.channels.fetch).toHaveBeenCalledWith("channel-logs");
    const channel = await member.guild.channels.fetch("channel-logs");
    expect((channel as any).send).toHaveBeenCalledWith(
      expect.stringContaining("Anti-Raid Flag"),
    );
  });

  test("sends welcome message to WELCOME_CHANNEL_ID for mature accounts", async () => {
    process.env.WELCOME_CHANNEL_ID = "channel-welcome";
    const event = new GuildMemberAddEvent();
    const member = fakeMember(100); // 100 hours old, above 72h

    await event.handle(member);

    expect(member.guild.channels.fetch).toHaveBeenCalledWith("channel-welcome");
    const channel = await member.guild.channels.fetch("channel-welcome");
    expect((channel as any).send).toHaveBeenCalledWith(
      expect.stringContaining("Welcome"),
    );
  });
});
