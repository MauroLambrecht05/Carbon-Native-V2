// The Component contract every message component (button, select menu) implements.

import type { MessageComponentInteraction } from "discord.js";

export interface ComponentMeta {
  /**
   * The customId or prefix to match against interaction.customId.
   */
  readonly customId: string;
  /**
   * When true, matches any interaction whose customId starts with this prefix
   * (e.g., "role:toggle:" matching "role:toggle:rust").
   */
  readonly isPrefix?: boolean;
}

export abstract class Component {
  abstract readonly meta: ComponentMeta;

  /**
   * Handle the component interaction (button click or select menu selection).
   * Reply (or defer, then follow up) directly on `interaction`. Throwing is
   * caught by ComponentRouter and returned as an ephemeral error.
   */
  abstract execute(interaction: MessageComponentInteraction): Promise<void>;
}
