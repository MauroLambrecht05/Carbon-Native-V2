// Routes a discord.js context menu command interaction (user/message) to the matching handler.

import type { ContextMenuCommandInteraction } from "discord.js";
import type { ContextMenuRegistry } from "./context-menu-registry.ts";

export class ContextMenuRouter {
  constructor(private readonly registry: ContextMenuRegistry) {}

  async route(interaction: ContextMenuCommandInteraction): Promise<void> {
    const descriptor = this.registry.resolve(interaction.commandName);

    if (!descriptor) {
      await interaction.reply({
        content: `unknown context menu command: ${interaction.commandName}`,
        ephemeral: true,
      });
      return;
    }

    try {
      const command = await descriptor.load();
      await command.execute(interaction);
    } catch (error) {
      const content = `context menu command failed: ${error instanceof Error ? error.message : String(error)}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
