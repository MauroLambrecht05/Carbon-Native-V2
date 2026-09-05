import { describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { AnnounceCommand } from "../../../presentation/commands/broadcast/announce.command.ts";

function fakeInteraction(options: {
  isAdmin: boolean;
  channelId?: string;
  title?: string;
  message?: string;
  ping?: string;
  style?: string;
}): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField();
  if (options.isAdmin) permissions.add(PermissionsBitField.Flags.Administrator);

  const mockChannel = {
    id: options.channelId || "announce-chan-1",
    send: mock(() => Promise.resolve()),
  };

  return {
    commandName: "announce",
    memberPermissions: permissions,
    user: { tag: "admin#0001", id: "user-admin" },
    options: {
      getChannel: mock((name: string) => ({ id: options.channelId || "announce-chan-1" })),
      getString: mock((name: string) => {
        if (name === "title") return options.title || "Engine v2.0 Released";
        if (name === "message") return options.message || "Big updates to SIMD computation!";
        if (name === "ping") return options.ping || "everyone";
        if (name === "style") return options.style || "brand";
        return null;
      }),
    },
    guild: {
      channels: {
        cache: {
          get: (id: string) => mockChannel,
        },
      },
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("AnnounceCommand", () => {
  test("rejects users lacking Administrator permission", async () => {
    const cmd = new AnnounceCommand();
    const interaction = fakeInteraction({ isAdmin: false });

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need Administrator permissions to broadcast announcements.",
      ephemeral: true,
    });
  });

  test("broadcasts formatted announcement embed with ping", async () => {
    const cmd = new AnnounceCommand();
    const interaction = fakeInteraction({
      isAdmin: true,
      channelId: "target-channel",
      title: "Maintenance Notice",
      message: "Build servers restarting in 10 minutes",
      ping: "everyone",
      style: "warning",
    });

    await cmd.execute(interaction);

    const channel = interaction.guild?.channels.cache.get("target-channel");
    expect((channel as any).send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "@everyone",
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "📢 Maintenance Notice",
              description: "Build servers restarting in 10 minutes",
            }),
          }),
        ]),
      }),
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("target-channel"),
      ephemeral: true,
    });
  });
});
