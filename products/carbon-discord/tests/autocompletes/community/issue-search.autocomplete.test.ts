import { describe, expect, mock, test, beforeEach } from "bun:test";
import type { AutocompleteInteraction } from "discord.js";
import { IssueSearchAutocomplete } from "../../../presentation/autocompletes/community/issue-search.autocomplete.ts";
import { IssueStore } from "../../../presentation/commands/community/issue-store.ts";

describe("IssueSearchAutocomplete", () => {
  beforeEach(() => {
    IssueStore.getInstance().clear();
  });

  test("suggests matching issue choices for query", async () => {
    const store = IssueStore.getInstance();
    store.addIssue({
      id: "CB-1010",
      title: "C++ SIMD AVX-512 alignment fault",
      component: "Runtime",
      environment: "Linux x64",
      details: "Bus error on unaligned load",
      authorId: "user-2",
      authorTag: "dev#0002",
      status: "Open",
      createdAt: new Date(),
    });

    const handler = new IssueSearchAutocomplete();
    const interaction = {
      commandName: "issue",
      options: {
        getFocused: mock(() => ({ name: "query", value: "SIMD" })),
      },
      respond: mock(() => Promise.resolve()),
    } as unknown as AutocompleteInteraction;

    await handler.handle(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([
      {
        name: "[CB-1010] C++ SIMD AVX-512 alignment fault",
        value: "CB-1010",
      },
    ]);
  });
});
