// Shared by signer.command.ts and publish.command.ts — both sign things with
// a locally-held private key and need the same password precedence.
//
// Order matters: an explicit --password wins, then the environment (how CI
// supplies it), then an interactive prompt. The prompt is last because a
// non-interactive run must fail loudly rather than block forever on a stdin
// that will never produce anything.

import type { CommandContext } from "@carbon/cli";

export async function resolvePassword(ctx: CommandContext, purpose: string): Promise<string> {
  const explicit = ctx.flags.get("password");
  if (explicit !== undefined) return explicit;

  const fromEnv = process.env.CARBON_SIGNER_PASSWORD;
  if (fromEnv !== undefined) return fromEnv;

  if (!process.stdin.isTTY) {
    throw new Error(
      "no password available: pass --password, or set CARBON_SIGNER_PASSWORD, or run interactively",
    );
  }

  process.stdout.write(`${purpose}: `);
  for await (const line of console) return line;
  return "";
}
