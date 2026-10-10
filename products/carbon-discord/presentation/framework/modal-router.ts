// Routes a discord.js modal submit interaction to the matching modal handler.

import type { ModalSubmitInteraction } from "discord.js";
import type { ModalRegistry } from "./modal-registry.ts";
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../infrastructure/state/audit-log.ts";
import { incrementMetric } from "../../infrastructure/state/metrics.ts";

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
      incrementMetric(interaction.guildId, `modal.${interaction.customId.split(":").slice(0, 2).join(".")}`);
    } catch (error) {
      const reference = randomUUID().slice(0, 8);
      console.error(`modal ${interaction.customId} failed [${reference}]`, error);
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user?.id ?? "unknown", action: `modal.${interaction.customId.split(":").slice(0, 2).join(".")}`, outcome: "failed", metadata: { reference } });
      const content = `Carbon could not submit that form. Reference: \`${reference}\`.`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
