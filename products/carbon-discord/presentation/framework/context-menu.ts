// The ContextMenuCommand contract every user/message context menu command implements.

import { type ContextMenuCommandInteraction, ApplicationCommandType } from "discord.js";

export interface ContextMenuMeta {
  /** The name of the context menu item as shown in Discord's context menu. */
  readonly name: string;
  /** Whether this action targets a user or a message. */
  readonly type: ApplicationCommandType.User | ApplicationCommandType.Message;
}

export abstract class ContextMenuCommand {
  abstract readonly meta: ContextMenuMeta;

  /**
   * Execute the context menu command.
   * Reply or defer on interaction directly.
   */
  abstract execute(interaction: ContextMenuCommandInteraction): Promise<void>;
}
