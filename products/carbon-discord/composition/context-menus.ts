// Every context menu command the bot has, in one place.
// Mirrors composition/commands.ts: metadata declared here, implementation
// behind a lazy `load()`.

import { ContextMenuRegistry } from "../presentation/framework/context-menu-registry.ts";

export function buildContextMenuRegistry(): ContextMenuRegistry {
  return new ContextMenuRegistry();
}
