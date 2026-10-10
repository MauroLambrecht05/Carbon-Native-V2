// Routes a discord.js context menu command interaction (user/message) to the matching handler.

import type { ContextMenuCommandInteraction } from "discord.js";
import type { ContextMenuRegistry } from "./context-menu-registry.ts";
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../infrastructure/state/audit-log.ts";
import { incrementMetric } from "../../infrastructure/state/metrics.ts";

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
      incrementMetric(interaction.guildId, `context.${interaction.commandName}`);
    } catch (error) {
      const reference = randomUUID().slice(0, 8);
      console.error(`context menu ${interaction.commandName} failed [${reference}]`, error);
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user?.id ?? "unknown", action: `context.${interaction.commandName}`, outcome: "failed", metadata: { reference } });
      const content = `Carbon could not complete that action. Reference: \`${reference}\`.`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
