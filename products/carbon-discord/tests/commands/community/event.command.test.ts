import { describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { EventCommand } from "../../../presentation/commands/community/event.command.ts";

function fakeInteraction(options: {
  isAdmin: boolean;
  subcommand: string;
}): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField();
  if (options.isAdmin) permissions.add(PermissionsBitField.Flags.Administrator);

  const mockChannel = {
    send: mock(() => Promise.resolve()),
  };

  return {
    commandName: "event",
    memberPermissions: permissions,
    channel: mockChannel,
    options: {
      getSubcommand: mock(() => options.subcommand),
      getString: mock((name: string) => {
        if (name === "title") return "V2 Architecture Town Hall";
        if (name === "description") return "Deep dive into FlatBuffers & Zig plugins";
        if (name === "time") return "Friday 18:00 UTC";
        if (name === "location") return "Stage Channel";
        return null;
      }),
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("EventCommand", () => {
  test("rejects non-admin for event creation", async () => {
    const cmd = new EventCommand();
    const interaction = fakeInteraction({ isAdmin: false, subcommand: "create" });

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need Administrator permissions to schedule official community events.",
      ephemeral: true,
    });
  });

  test("schedules community event with RSVP button when run by admin", async () => {
    const cmd = new EventCommand();
    const interaction = fakeInteraction({ isAdmin: true, subcommand: "create" });

    await cmd.execute(interaction);

    expect((interaction.channel as any).send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "📅 Community Event: V2 Architecture Town Hall",
            }),
          }),
        ]),
        components: expect.any(Array),
      }),
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("scheduled successfully"),
      ephemeral: true,
    });
  });

  test("lists upcoming events", async () => {
    const cmd = new EventCommand();
    const interaction = fakeInteraction({ isAdmin: false, subcommand: "list" });

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        ephemeral: true,
      }),
    );
  });
});
