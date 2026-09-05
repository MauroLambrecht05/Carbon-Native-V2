// The Autocomplete contract every slash command autocomplete handler implements.

import type { AutocompleteInteraction } from "discord.js";

export interface AutocompleteMeta {
  /** The slash command name this autocomplete handler serves. */
  readonly commandName: string;
}

export abstract class Autocomplete {
  abstract readonly meta: AutocompleteMeta;

  /**
   * Suggest options back to Discord.
   * Call `interaction.respond(...)` with up to 25 choices.
   */
  abstract handle(interaction: AutocompleteInteraction): Promise<void>;
}
