// Every slash command autocomplete handler the bot has, in one place.
// Mirrors composition/commands.ts: metadata declared here, implementation
// behind a lazy `load()`.

import {
  AutocompleteRegistry,
  defineAutocomplete,
} from "../presentation/framework/autocomplete-registry.ts";

export function buildAutocompleteRegistry(): AutocompleteRegistry {
  return new AutocompleteRegistry().register(
    defineAutocomplete(
      { commandName: "issue" },
      async () =>
        new (await import(
          "../presentation/autocompletes/community/issue-search.autocomplete.ts"
        )).IssueSearchAutocomplete(),
    ),
  );
}
