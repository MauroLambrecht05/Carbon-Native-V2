import { afterEach, describe, expect, mock, test } from "bun:test";
import { PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";
import { EventCommand } from "../../../presentation/commands/community/event.command.ts";

function fakeInteraction(options: { isAdmin: boolean; subcommand: "create" | "list" }): ChatInputCommandInteraction {
  const permissions = new PermissionsBitField();
  if (options.isAdmin) permissions.add(PermissionsBitField.Flags.Administrator);
  const event = { id: "event-1", name: "Carbon workshop", scheduledStartTimestamp: Date.now() + 3_600_000, url: "https://discord.com/events/1/2" };
  const scheduledEvents = {
    create: mock(() => Promise.resolve(event)),
    fetch: mock(() => Promise.resolve(new Map([[event.id, event]]))),
  };
  return {
    commandName: "event",
    user: { id: "user-1", tag: "user#1" },
    memberPermissions: permissions,
    guildId: "guild-1",
    guild: { scheduledEvents },
    options: {
      getSubcommand: mock(() => options.subcommand),
      getString: mock((name: string) => ({
        title: "Carbon workshop",
        description: "Build a native application together",
        starts_at: new Date(Date.now() + 3_600_000).toISOString(),
        location: "Carbon Stage",
      })[name] ?? null),
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as ChatInputCommandInteraction;
}

describe("EventCommand", () => {
  afterEach(() => { delete process.env.COMMUNITY_MANAGER_ROLE_IDS; });

  test("rejects unauthorized event creation", async () => {
    const interaction = fakeInteraction({ isAdmin: false, subcommand: "create" });
    await new EventCommand().execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: "This action is restricted to authorized Carbon staff.", ephemeral: true });
  });

  test("creates a native Discord scheduled event", async () => {
    const interaction = fakeInteraction({ isAdmin: true, subcommand: "create" });
    await new EventCommand().execute(interaction);
    expect(interaction.guild!.scheduledEvents.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Carbon workshop", entityMetadata: { location: "Carbon Stage" } }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Created **Carbon workshop**"), ephemeral: true }));
  });

  test("lists native Discord scheduled events", async () => {
    const interaction = fakeInteraction({ isAdmin: false, subcommand: "list" });
    await new EventCommand().execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array), ephemeral: true }));
  });
});
