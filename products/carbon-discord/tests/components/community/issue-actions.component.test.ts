import { describe, expect, mock, test, beforeEach } from "bun:test";
import { EmbedBuilder, type MessageComponentInteraction } from "discord.js";
import { IssueActionsComponent } from "../../../presentation/components/community/issue-actions.component.ts";
import { IssueStore } from "../../../presentation/commands/community/issue-store.ts";

describe("IssueActionsComponent", () => {
  beforeEach(() => {
    IssueStore.getInstance().clear();
  });

  test("confirms issue and updates message embed", async () => {
    const store = IssueStore.getInstance();
    store.addIssue({
      id: "CB-9999",
      title: "Sample bug",
      component: "CLI",
      environment: "Linux",
      details: "details",
      authorId: "user-1",
      authorTag: "user#0001",
      status: "Open",
      createdAt: new Date(),
    });

    const component = new IssueActionsComponent();
    const sampleEmbed = new EmbedBuilder()
      .setTitle("🐛 [CB-9999] Sample bug")
      .addFields({ name: "Status", value: "🟡 **Open**", inline: true });

    const interaction = {
      customId: "issue:confirm:CB-9999",
      user: { id: "admin-1" },
      message: {
        embeds: [sampleEmbed],
      },
      update: mock(() => Promise.resolve()),
      reply: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );

    const issue = store.getIssue("CB-9999");
    expect(issue?.status).toBe("Confirmed");
  });
});
