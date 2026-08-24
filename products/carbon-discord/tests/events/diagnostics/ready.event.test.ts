import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChannelType, type Client } from "discord.js";
import { ReadyEvent } from "../../../presentation/events/diagnostics/ready.event.ts";

const originalChannelId = process.env.STARTUP_CHANNEL_ID;

afterEach(() => {
  if (originalChannelId === undefined) delete process.env.STARTUP_CHANNEL_ID;
  else process.env.STARTUP_CHANNEL_ID = originalChannelId;
});

function fakeClient(fetchResult: unknown = null) {
  return {
    user: { tag: "Carbon#5780" },
    channels: { fetch: mock(() => Promise.resolve(fetchResult)) },
  } as unknown as Client<true>;
}

describe("ReadyEvent", () => {
  test("logs the bot's tag, and does not touch a channel when STARTUP_CHANNEL_ID is unset", async () => {
    delete process.env.STARTUP_CHANNEL_ID;
    const log = mock(() => {});
    const originalLog = console.log;
    console.log = log;
    const client = fakeClient();

    try {
      await new ReadyEvent().handle(client);
    } finally {
      console.log = originalLog;
    }

    expect(log).toHaveBeenCalledWith("carbon-discord logged in as Carbon#5780");
    expect(client.channels.fetch).not.toHaveBeenCalled();
  });

  test("also announces to the configured channel", async () => {
    process.env.STARTUP_CHANNEL_ID = "1363426336386977855";
    const send = mock(() => Promise.resolve());
    const client = fakeClient({ type: ChannelType.GuildText, send });

    await new ReadyEvent().handle(client);

    expect(client.channels.fetch).toHaveBeenCalledWith("1363426336386977855");
    // HH:MM, 24-hour, in the bot process's own timezone (hour12: false makes
    // the hour deterministic regardless of locale default).
    expect(send).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{2}:\d{2} \| Carbon is online\. Try \/help to see what it can do\.$/),
    );
  });

  test("logs instead of crashing when the configured channel isn't a postable text channel", async () => {
    process.env.STARTUP_CHANNEL_ID = "1363426336386977855";
    const client = fakeClient({ type: ChannelType.GuildVoice });
    const error = mock(() => {});
    const originalError = console.error;
    console.error = error;

    try {
      await new ReadyEvent().handle(client);
    } finally {
      console.error = originalError;
    }

    expect(error).toHaveBeenCalledWith(
      "STARTUP_CHANNEL_ID 1363426336386977855 is not a postable guild text channel",
    );
  });

  test("fires once, not on every occurrence", () => {
    expect(new ReadyEvent().meta.once).toBe(true);
  });
});
