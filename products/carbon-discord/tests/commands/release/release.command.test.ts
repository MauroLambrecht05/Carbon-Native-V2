import { describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { ReleaseCommand } from "../../../presentation/commands/release/release.command.ts";

function fakeInteraction(options: {
  isAdmin: boolean;
  version?: string;
  highlights?: string;
  channel?: string;
}): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField();
  if (options.isAdmin) permissions.add(PermissionsBitField.Flags.Administrator);

  const mockChannel = {
    send: mock(() => Promise.resolve()),
  };

  return {
    commandName: "release",
    memberPermissions: permissions,
    channel: mockChannel,
    options: {
      getString: mock((name: string) => {
        if (name === "version") return options.version || "v2.1.0";
        if (name === "highlights") return options.highlights || "- Zero-copy FlatBuffers\n- Zig plugin dynamic linking";
        if (name === "channel") return options.channel || "stable";
        return null;
      }),
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("ReleaseCommand", () => {
  test("rejects non-admin users", async () => {
    const cmd = new ReleaseCommand();
    const interaction = fakeInteraction({ isAdmin: false });

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need Administrator permissions to publish release cards.",
      ephemeral: true,
    });
  });

  test("publishes release showcase card with buttons and metadata", async () => {
    const cmd = new ReleaseCommand();
    const interaction = fakeInteraction({
      isAdmin: true,
      version: "v2.5.0",
      highlights: "High speed vector math SIMD engine update",
      channel: "stable",
    });

    await cmd.execute(interaction);

    expect((interaction.channel as any).send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "🚀 Carbon Native v2.5.0 Released!",
              description: expect.stringContaining("High speed vector math SIMD engine update"),
            }),
          }),
        ]),
        components: expect.any(Array),
      }),
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("v2.5.0"),
      ephemeral: true,
    });
  });
});
