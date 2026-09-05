import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { ResolveThreadComponent } from "../../../presentation/components/community/resolve-thread.component.ts";

describe("ResolveThreadComponent", () => {
  test("resolves and archives thread upon button click", async () => {
    const component = new ResolveThreadComponent();

    const mockThread = {
      isThread: () => true,
      name: "flatbuffers schema generation",
      setName: mock(() => Promise.resolve()),
      setLocked: mock(() => Promise.resolve()),
      setArchived: mock(() => Promise.resolve()),
    };

    const interaction = {
      customId: "thread:resolve",
      user: { id: "user-helper" },
      channel: mockThread,
      reply: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(mockThread.setName).toHaveBeenCalledWith(
      "[SOLVED] flatbuffers schema generation",
    );
    expect(mockThread.setLocked).toHaveBeenCalledWith(true);
    expect(mockThread.setArchived).toHaveBeenCalledWith(true);
  });
});
