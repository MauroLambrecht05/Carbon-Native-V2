import type { AutocompleteInteraction } from "discord.js";
import { Autocomplete, type AutocompleteMeta } from "../../framework/autocomplete.ts";
import { IssueStore } from "../../commands/community/issue-store.ts";

export class IssueSearchAutocomplete extends Autocomplete {
  readonly meta: AutocompleteMeta = { commandName: "issue" };

  async handle(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (!focused || focused.name !== "query") {
      await interaction.respond([]);
      return;
    }

    const store = IssueStore.getInstance();
    const results = store.searchIssues(focused.value);

    const choices = results.map((issue) => ({
      name: `[${issue.id}] ${issue.title}`.slice(0, 100),
      value: issue.id,
    }));

    await interaction.respond(choices);
  }
}
