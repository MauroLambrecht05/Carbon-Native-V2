import { Command, type CommandMeta, type ExitCode } from "@carbon/cli";
import type { CommandContext } from "@carbon/cli";
// `carbon create <name>` — scaffold a new app from a template. Stubbed until
// we ship a real template registry. The plan: copy from carbon-native/templates/
// (which we'll add in Phase 1A alongside real-JSX support).

import { log } from "@carbon/logging";

export async function createCommand(_rest: string[]): Promise<number> {
  log.warn(
    `carbon create is not implemented yet. For now, copy examples/hello/ as a starting point.`,
  );
  return 1;
}


// ── Command ─────────────────────────────────────────────────────────────────
// The implementation above is the ported V1 body, unchanged. This class is
// what the registry routes to: metadata lives beside the code it describes,
// so help and dispatch cannot drift from each other.

export class CreateCommand extends Command {
  readonly meta: CommandMeta = {
    name: "create",
    summary: "Deprecated alias of init",
    usage: "create <name>",
    deprecated: "use `carbon init` instead",
    hidden: true,
  };

  execute(ctx: CommandContext): Promise<ExitCode> {
    return createCommand([...ctx.argv]);
  }
}

export default CreateCommand;
