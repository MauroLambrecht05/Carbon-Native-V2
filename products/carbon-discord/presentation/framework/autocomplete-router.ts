// Routes a discord.js autocomplete interaction to the matching autocomplete handler.

import type { AutocompleteInteraction } from "discord.js";
import type { AutocompleteRegistry } from "./autocomplete-registry.ts";

export class AutocompleteRouter {
  constructor(private readonly registry: AutocompleteRegistry) {}

  async route(interaction: AutocompleteInteraction): Promise<void> {
    const descriptor = this.registry.resolve(interaction.commandName);

    if (!descriptor) {
      if (!interaction.responded) {
        await interaction.respond([]);
      }
      return;
    }

    try {
      const handler = await descriptor.load();
      await handler.handle(interaction);
    } catch (error) {
      console.error(`autocomplete for "${interaction.commandName}" failed:`, error);
      if (!interaction.responded) {
        try {
          await interaction.respond([]);
        } catch {
          // Interaction may have timed out or closed
        }
      }
    }
  }
}
