import { describe, expect, mock, test, beforeEach } from "bun:test";
import type { ModalSubmitInteraction } from "discord.js";
import { IssueCreateModal } from "../../../presentation/modals/community/issue-create.modal.ts";
import { IssueStore } from "../../../presentation/commands/community/issue-store.ts";

describe("IssueCreateModal", () => {
  beforeEach(() => {
    IssueStore.getInstance().clear();
  });

  test("stores issue and posts formatted bug card", async () => {
    const modal = new IssueCreateModal();

    const mockChannel = {
      id: "channel-issues",
      send: mock(() => Promise.resolve()),
    };

    const interaction = {
      customId: "modal:issue-create",
      user: { id: "author-1", tag: "tester#0001" },
      channel: mockChannel,
      fields: {
        getTextInputValue: mock((field: string) => {
          if (field === "issue-title") return "FlatBuffers zero-copy panic";
          if (field === "issue-component") return "Runtime";
          if (field === "issue-env") return "macOS aarch64";
          if (field === "issue-details") return "Panic occurs when buffer size is empty";
          return "";
        }),
      },
      reply: mock(() => Promise.resolve()),
    } as unknown as ModalSubmitInteraction;

    await modal.execute(interaction);

    expect(mockChannel.send).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              title: expect.stringContaining("FlatBuffers zero-copy panic"),
            }),
          }),
        ]),
        components: expect.any(Array),
      }),
    );

    const issues = IssueStore.getInstance().searchIssues("FlatBuffers");
    expect(issues.length).toBe(1);
    expect(issues[0].component).toBe("Runtime");

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("channel-issues"),
        ephemeral: true,
      }),
    );
  });
});
