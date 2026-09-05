import { describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { SetupVerificationCommand } from "../../../presentation/commands/onboarding/setup-verification.command.ts";

function fakeInteraction(isAdmin = true): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField();
  if (isAdmin) permissions.add(PermissionsBitField.Flags.Administrator);

  return {
    commandName: "setup-verification",
    memberPermissions: permissions,
    channel: {
      send: mock(() => Promise.resolve()),
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("SetupVerificationCommand", () => {
  test("rejects users lacking Administrator permission", async () => {
    const cmd = new SetupVerificationCommand();
    const interaction = fakeInteraction(false);

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You need Administrator permissions to deploy the verification panel.",
      ephemeral: true,
    });
    expect((interaction.channel as any).send).not.toHaveBeenCalled();
  });

  test("deploys verification embed and button row when run by admin", async () => {
    const cmd = new SetupVerificationCommand();
    const interaction = fakeInteraction(true);

    await cmd.execute(interaction);

    expect((interaction.channel as any).send).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Verification panel deployed successfully.",
      ephemeral: true,
    });
  });
});
