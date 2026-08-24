// The Command contract every slash command implements.

import type { ChatInputCommandInteraction } from "discord.js";

export interface CommandMeta {
  /** The slash command name, as registered with Discord and typed by a user. */
  readonly name: string;
  /** Shown in Discord's command picker. */
  readonly description: string;
}

export abstract class Command {
  abstract readonly meta: CommandMeta;

  /** Do the work. Reply (or defer, then follow up) on `interaction` yourself:
   * discord.js has no return-a-response-object shape the way the raw
   * Interactions API does. Throwing is fine: the router turns it into an
   * ephemeral error reply. */
  abstract execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
