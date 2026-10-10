import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordDatabase } from "../../infrastructure/state/database.ts";
import { consumeRateLimit } from "../../infrastructure/state/rate-limit.ts";
import { TicketStore } from "../../infrastructure/state/ticket-store.ts";
import { IssueStore } from "../../presentation/commands/community/issue-store.ts";

describe("durable Discord state", () => {
  let temporaryDirectory: string | undefined;

  afterEach(() => {
    DiscordDatabase.replaceForTests();
    if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  });

  test("issues and tickets survive a database reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "carbon-discord-"));
    const path = join(temporaryDirectory, "state.sqlite");
    DiscordDatabase.replaceForTests(path);
    IssueStore.getInstance().addIssue({
      id: "CB-DURABLE1", guildId: "guild-1", title: "Durable issue", component: "CLI",
      environment: "Windows x64", details: "State should survive restart", authorId: "user-1",
      authorTag: "user#1", status: "Open", createdAt: new Date("2026-09-06T12:00:00Z"),
    });
    TicketStore.getInstance().create({ threadId: "thread-1", guildId: "guild-1", openerId: "user-1", subject: "Private help", category: "CLI" });

    DiscordDatabase.replaceForTests(path);
    expect(IssueStore.getInstance().getIssue("CB-DURABLE1")?.title).toBe("Durable issue");
    expect(TicketStore.getInstance().get("thread-1")?.openerId).toBe("user-1");
  });

  test("rate limits are enforced atomically", () => {
    DiscordDatabase.replaceForTests();
    expect(consumeRateLimit("guild-1", "user-1", "test", { limit: 2, windowMs: 60_000 })).toBe(true);
    expect(consumeRateLimit("guild-1", "user-1", "test", { limit: 2, windowMs: 60_000 })).toBe(true);
    expect(consumeRateLimit("guild-1", "user-1", "test", { limit: 2, windowMs: 60_000 })).toBe(false);
  });
});
