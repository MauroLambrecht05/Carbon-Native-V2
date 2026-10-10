import { describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { TicketPanelCommand } from "../../../presentation/commands/ticketing/ticket-panel.command.ts";

function fakeInteraction(isAdmin = true): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField();
  if (isAdmin) permissions.add(PermissionsBitField.Flags.Administrator);

  return {
    commandName: "ticket-panel",
    memberPermissions: permissions,
    user: { id: "staff-1" },
    channel: {
      send: mock(() => Promise.resolve()),
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("TicketPanelCommand", () => {
  test("rejects users lacking Administrator permission", async () => {
    const cmd = new TicketPanelCommand();
    const interaction = fakeInteraction(false);

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This action is restricted to authorized Carbon staff.",
      ephemeral: true,
    });
    expect((interaction.channel as any).send).not.toHaveBeenCalled();
  });

  test("deploys ticket panel embed and button when run by admin", async () => {
    const cmd = new TicketPanelCommand();
    const interaction = fakeInteraction(true);

    await cmd.execute(interaction);

    expect((interaction.channel as any).send).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Private support panel deployed.",
      ephemeral: true,
    });
  });
});
