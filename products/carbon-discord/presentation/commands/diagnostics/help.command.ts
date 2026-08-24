// Lists every registered command by reading composition/commands.ts's own
// registry, rather than a hand-maintained list, so this can never drift
// from what's actually wired up. Takes the registry *builder*, not a
// registry instance: composition/commands.ts's loader calls
// buildCommandRegistry() lazily inside execute(), well after the outer
// buildCommandRegistry() call that registered "help" itself has returned,
// so there is no self-reference at construction time, only a fresh
// independent call each time /help actually runs.

import type { ChatInputCommandInteraction } from "discord.js";
import { EmbedBuilder } from "discord.js";
import { Command, type CommandMeta } from "../../framework/command.ts";
import type { CommandRegistry } from "../../framework/command-registry.ts";

export class HelpCommand extends Command {
  readonly meta: CommandMeta = {
    name: "help",
    description: "List every command Carbon has",
  };

  constructor(private readonly buildRegistry: () => CommandRegistry) {
    super();
  }

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const commands = this.buildRegistry().all();

    const embed = new EmbedBuilder()
      .setTitle("Carbon: commands")
      .setColor(0x2b7a4b)
      .addFields(commands.map((descriptor) => ({ name: `/${descriptor.meta.name}`, value: descriptor.meta.description })));

    await interaction.reply({ embeds: [embed] });
  }
}
