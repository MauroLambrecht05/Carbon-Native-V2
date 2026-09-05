// Routes a discord.js message component interaction (button click, select menu)
// to the matching component handler in the registry.

import type { MessageComponentInteraction } from "discord.js";
import type { ComponentRegistry } from "./component-registry.ts";

export class ComponentRouter {
  constructor(private readonly registry: ComponentRegistry) {}

  async route(interaction: MessageComponentInteraction): Promise<void> {
    const descriptor = this.registry.resolve(interaction.customId);

    if (!descriptor) {
      await interaction.reply({
        content: `unknown component: ${interaction.customId}`,
        ephemeral: true,
      });
      return;
    }

    try {
      const component = await descriptor.load();
      await component.execute(interaction);
    } catch (error) {
      const content = `component failed: ${error instanceof Error ? error.message : String(error)}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
