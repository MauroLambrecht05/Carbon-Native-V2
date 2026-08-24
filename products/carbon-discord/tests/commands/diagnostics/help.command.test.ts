import { describe, expect, mock, test } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { HelpCommand } from "../../../presentation/commands/diagnostics/help.command.ts";
import { CommandRegistry, defineCommand } from "../../../presentation/framework/command-registry.ts";
import { Command, type CommandMeta } from "../../../presentation/framework/command.ts";

class FakeCommand extends Command {
  constructor(readonly meta: CommandMeta) {
    super();
  }
  async execute(): Promise<void> {}
}

function fakeRegistry(): CommandRegistry {
  return new CommandRegistry().register(
    defineCommand({ name: "ping", description: "Check that the bot is alive" }, async () =>
      new FakeCommand({ name: "ping", description: "Check that the bot is alive" }),
    ),
    defineCommand({ name: "status", description: "Show the bot's live connection status" }, async () =>
      new FakeCommand({ name: "status", description: "Show the bot's live connection status" }),
    ),
  );
}

describe("HelpCommand", () => {
  test("lists every command from a freshly built registry, not a snapshot taken at construction", async () => {
    const reply = mock((_options: { embeds: EmbedBuilder[] }) => Promise.resolve());
    const interaction = { reply } as unknown as ChatInputCommandInteraction;

    await new HelpCommand(fakeRegistry).execute(interaction);

    expect(reply).toHaveBeenCalledTimes(1);
    const [{ embeds }] = reply.mock.calls[0] as [{ embeds: EmbedBuilder[] }];
    const data = embeds[0].data;

    expect(data.title).toBe("Carbon: commands");
    expect(data.fields).toContainEqual({ name: "/ping", value: "Check that the bot is alive" });
    expect(data.fields).toContainEqual({ name: "/status", value: "Show the bot's live connection status" });
  });
});
