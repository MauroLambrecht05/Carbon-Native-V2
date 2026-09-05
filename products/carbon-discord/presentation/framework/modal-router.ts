// Routes a discord.js modal submit interaction to the matching modal handler.

import type { ModalSubmitInteraction } from "discord.js";
import type { ModalRegistry } from "./modal-registry.ts";

export class ModalRouter {
  constructor(private readonly registry: ModalRegistry) {}

  async route(interaction: ModalSubmitInteraction): Promise<void> {
    const descriptor = this.registry.resolve(interaction.customId);

    if (!descriptor) {
      await interaction.reply({
        content: `unknown modal: ${interaction.customId}`,
        ephemeral: true,
      });
      return;
    }

    try {
      const modal = await descriptor.load();
      await modal.execute(interaction);
    } catch (error) {
      const content = `modal failed: ${error instanceof Error ? error.message : String(error)}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
