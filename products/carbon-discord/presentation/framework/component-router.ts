// Routes a discord.js message component interaction (button click, select menu)
// to the matching component handler in the registry.

import type { MessageComponentInteraction } from "discord.js";
import type { ComponentRegistry } from "./component-registry.ts";
import { randomUUID } from "node:crypto";
import { recordAudit } from "../../infrastructure/state/audit-log.ts";
import { incrementMetric } from "../../infrastructure/state/metrics.ts";

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
      incrementMetric(interaction.guildId, `component.${interaction.customId.split(":").slice(0, 2).join(".")}`);
    } catch (error) {
      const reference = randomUUID().slice(0, 8);
      console.error(`component ${interaction.customId} failed [${reference}]`, error);
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user?.id ?? "unknown", action: `component.${interaction.customId.split(":").slice(0, 2).join(".")}`, outcome: "failed", metadata: { reference } });
      const content = `Carbon could not complete that action. Reference: \`${reference}\`.`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
