import { describe, expect, mock, test, beforeEach } from "bun:test";
import type { ChatInputCommandInteraction } from "discord.js";
import { IssueCommand } from "../../../presentation/commands/community/issue.command.ts";
import { IssueStore } from "../../../presentation/commands/community/issue-store.ts";

describe("IssueCommand", () => {
  beforeEach(() => {
    IssueStore.getInstance().clear();
  });

  test("presents issue creation modal when subcommand is create", async () => {
    const cmd = new IssueCommand();
    const interaction = {
      commandName: "issue",
      options: {
        getSubcommand: mock(() => "create"),
      },
      showModal: mock(() => Promise.resolve()),
    } as unknown as ChatInputCommandInteraction;

    await cmd.execute(interaction);

    expect(interaction.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          custom_id: "modal:issue-create",
          title: "Report Community Bug / Issue",
        }),
      }),
    );
  });

  test("searches and returns issue embed when subcommand is search", async () => {
    const store = IssueStore.getInstance();
    store.addIssue({
      id: "CB-4040",
      title: "Zig export symbol crash",
      component: "Plugins",
      environment: "Windows x64",
      details: "Crash occurs on DLL load",
      authorId: "user-1",
      authorTag: "user#0001",
      status: "Confirmed",
      createdAt: new Date(),
    });

    const cmd = new IssueCommand();
    const interaction = {
      commandName: "issue",
      options: {
        getSubcommand: mock(() => "search"),
        getString: mock(() => "CB-4040"),
      },
      reply: mock(() => Promise.resolve()),
    } as unknown as ChatInputCommandInteraction;

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: "🐛 [CB-4040] Zig export symbol crash",
            }),
          }),
        ]),
      }),
    );
  });
});
