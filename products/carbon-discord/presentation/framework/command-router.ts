// Routes a discord.js chat-input interaction to the matching command in the
// registry. discord.js's Client already authenticates the gateway
// connection with the bot token, so unlike the HTTP-Interactions design
// this replaced, there is no per-request signature to verify here: an
// interaction event from the Client is already trusted by construction.
//
// Named for exactly what it routes, a chat-input command, rather than
// "InteractionRouter": context-menu commands, message components and
// modals are also interactions, and each will need its own router keyed by
// its own thing (a command name here, a customId for the other two), not
// one router trying to be generic over all of them.

import type { ChatInputCommandInteraction } from "discord.js";
import type { CommandRegistry } from "./command-registry.ts";

export class CommandRouter {
  constructor(private readonly registry: CommandRegistry) {}

  async route(interaction: ChatInputCommandInteraction): Promise<void> {
    const descriptor = this.registry.resolve(interaction.commandName);

    if (!descriptor) {
      await interaction.reply({ content: `unknown command: ${interaction.commandName}`, ephemeral: true });
      return;
    }

    try {
      const command = await descriptor.load();
      await command.execute(interaction);
    } catch (error) {
      const content = `command failed: ${error instanceof Error ? error.message : String(error)}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
