// The HelpPresenter port.
//
// A CommandContext carries "how do I render help", and CommandGroup uses it
// when a subcommand is missing or wrong. Depending on the concrete
// HelpRenderer would make domain/ import application/ — the exact inversion
// this layering exists to prevent — so the context depends on this interface
// and the dispatcher injects the renderer that satisfies it.

import type { Command, CommandGroup, CommandMeta } from "../kernel/command.ts";

export interface HelpPresenter {
  renderRoot(): string;
  renderCommand(meta: CommandMeta): string;
  renderGroup(group: CommandGroup): string;
}

export type { Command };
