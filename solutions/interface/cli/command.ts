// The Command contract every command inherits.
//
// This layer knows nothing about carbon — no manifests, no backends, no build
// pipeline. It could dispatch any CLI. That constraint is what keeps the
// framework testable without a project on disk, and it is why `kernel/` sits
// below `commands/` in the dependency direction and never imports upward.

import type { CommandContext } from "./command-context.ts";
import type { FlagSpec } from "./flags.ts";

/**
 * Everything needed to describe a command *without loading it*.
 *
 * Metadata is declared statically and separately from the implementation so
 * `carbon --help` can render the full command list without importing vite,
 * rollup or babel. That laziness is not an optimisation detail — it is most of
 * the CLI's cold-start budget. See kernel/registry.ts.
 */
export interface CommandMeta {
  /** Primary name, as typed: `carbon <name>`. */
  readonly name: string;
  /** Alternative names that resolve to this command. */
  readonly aliases?: readonly string[];
  /** One line, shown in the command list. */
  readonly summary: string;
  /** Usage line, without the leading `carbon`. */
  readonly usage?: string;
  /** Flags this command understands, for help and validation. */
  readonly flags?: readonly FlagSpec[];
  /** Example invocations, shown in `carbon help <name>`. */
  readonly examples?: readonly string[];
  /** Hidden from the command list but still dispatchable. */
  readonly hidden?: boolean;
  /** Shown as a deprecation notice before the command runs. */
  readonly deprecated?: string;
}

/** Commands return a process exit code. 0 is success. */
export type ExitCode = number;

export const EXIT_OK: ExitCode = 0;
export const EXIT_FAILURE: ExitCode = 1;
export const EXIT_USAGE: ExitCode = 2;

export abstract class Command {
  abstract readonly meta: CommandMeta;

  /** Do the work. Throwing is fine — the dispatcher renders and converts it. */
  abstract execute(ctx: CommandContext): Promise<ExitCode>;

  /**
   * Optional guard run before `execute`. Return a message to abort with a
   * usage error; return null to proceed. Use it for "this needs a project",
   * not for argument parsing, which belongs in execute.
   */
  validate?(ctx: CommandContext): string | null;
}

/**
 * A command that dispatches to subcommands: `carbon plugin new`,
 * `carbon signer generate`.
 *
 * Subcommands are ordinary Commands, so they get the same metadata, help and
 * validation as top-level ones rather than each group hand-rolling its own
 * argument switch — which is what the ported V1 code did five separate times.
 */
export abstract class CommandGroup extends Command {
  abstract readonly subcommands: readonly Command[];

  /** Name of the subcommand to run when none is given. Defaults to help. */
  protected readonly defaultSubcommand?: string;

  find(name: string): Command | undefined {
    return this.subcommands.find(
      (sub) => sub.meta.name === name || sub.meta.aliases?.includes(name),
    );
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const requested = ctx.args[0] ?? this.defaultSubcommand;

    if (!requested || requested === "help" || requested === "--help" || requested === "-h") {
      ctx.io.raw(ctx.help.renderGroup(this));
      return EXIT_OK;
    }

    const sub = this.find(requested);
    if (!sub) {
      ctx.io.error(`unknown ${this.meta.name} subcommand: ${ctx.io.c.red(requested)}`);
      ctx.io.raw(ctx.help.renderGroup(this));
      return EXIT_USAGE;
    }

    // Descend first, then validate: the subcommand's own name has to be
    // consumed before `ctx.first` means "the subcommand's first argument".
    const child = ctx.descend();

    const problem = sub.validate?.(child);
    if (problem) {
      ctx.io.error(problem);
      ctx.io.raw(ctx.help.renderCommand(sub.meta));
      return EXIT_USAGE;
    }

    return sub.execute(child);
  }
}
