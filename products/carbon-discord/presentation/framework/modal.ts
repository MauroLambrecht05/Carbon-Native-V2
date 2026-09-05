// The Modal contract every modal submit handler implements.

import type { ModalSubmitInteraction } from "discord.js";

export interface ModalMeta {
  /**
   * The customId or prefix to match against interaction.customId.
   */
  readonly customId: string;
  /**
   * When true, matches any interaction whose customId starts with this prefix.
   */
  readonly isPrefix?: boolean;
}

export abstract class Modal {
  abstract readonly meta: ModalMeta;

  /**
   * Handle the modal submission.
   * Reply (or defer, then follow up) directly on `interaction`.
   */
  abstract execute(interaction: ModalSubmitInteraction): Promise<void>;
}
