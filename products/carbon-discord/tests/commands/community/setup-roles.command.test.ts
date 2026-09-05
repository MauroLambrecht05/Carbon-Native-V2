import { describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { SetupRolesCommand } from "../../../presentation/commands/community/setup-roles.command.ts";

function fakeInteraction(isAdmin = true): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField();
  if (isAdmin) permissions.add(PermissionsBitField.Flags.Administrator);

  const mockChannel = {
    send: mock(() => Promise.resolve()),
  };

  return {
    commandName: "setup-roles",
    memberPermissions: permissions,
    channel: mockChannel,
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("SetupRolesCommand", () => {
  test("rejects non-administrator callers", async () => {
    const cmd = new SetupRolesCommand();
    const interaction = fakeInteraction(false);

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need Administrator permissions to deploy the role picker panel.",
      ephemeral: true,
    });
  });

  test("deploys role selection rows when run by admin", async () => {
    const cmd = new SetupRolesCommand();
    const interaction = fakeInteraction(true);

    await cmd.execute(interaction);

    expect((interaction.channel as any).send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.arrayContaining([expect.any(Object)]),
      }),
    );

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Role picker panel deployed successfully.",
      ephemeral: true,
    });
  });
});
