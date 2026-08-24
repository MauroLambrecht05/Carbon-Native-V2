// Does the assembled thing work: a fake interaction in, the right calls on
// it out. Uses the real registry for /ping: a break in composition/
// commands.ts's wiring fails this, not just a hand-wavy unit test of
// PingCommand alone.

import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { CommandRouter } from "../presentation/framework/command-router.ts";
import { CommandRegistry } from "../presentation/framework/command-registry.ts";
import { buildCommandRegistry } from "../composition/commands.ts";

function fakeInteraction(commandName: string): ChatInputCommandInteraction {
  return {
    commandName,
    replied: false,
    deferred: false,
    reply: mock(() => Promise.resolve()),
    followUp: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("CommandRouter", () => {
  test("routes /ping through the real registry", async () => {
    const router = new CommandRouter(buildCommandRegistry());
    const interaction = fakeInteraction("ping");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Pong!");
  });

  test("replies with a graceful fallback for an unregistered command, not a crash", async () => {
    const router = new CommandRouter(new CommandRegistry());
    const interaction = fakeInteraction("nonexistent");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "unknown command: nonexistent", ephemeral: true });
  });
});
