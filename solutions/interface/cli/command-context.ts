// What a command is handed when it runs.
//
// One object rather than a bag of parameters, so adding a capability later
// (a cancellation signal, a progress reporter) does not change every command
// signature.

import type { Flags } from "./flags.ts";
import type { Io } from "./io-port.ts";
import type { HelpPresenter } from "./help-presenter.ts";

export interface CommandContextInit {
  readonly args: string[];
  readonly flags: Flags;
  readonly passthrough: string[];
  readonly cwd: string;
  readonly io: Io;
  readonly help: HelpPresenter;
  readonly argv: readonly string[];
}

export class CommandContext {
  /** Positional arguments, with the command name already consumed. */
  readonly args: string[];
  readonly flags: Flags;
  /** Everything after a bare `--`. */
  readonly passthrough: string[];
  readonly cwd: string;
  readonly io: Io;
  readonly help: HelpPresenter;
  /** The raw argv slice this command received, for handing to ported code. */
  readonly argv: readonly string[];

  constructor(init: CommandContextInit) {
    this.args = init.args;
    this.flags = init.flags;
    this.passthrough = init.passthrough;
    this.cwd = init.cwd;
    this.io = init.io;
    this.help = init.help;
    this.argv = init.argv;
  }

  /**
   * A context for a subcommand: the first positional is consumed, everything
   * else carries over. Lets a CommandGroup delegate without re-parsing.
   */
  descend(): CommandContext {
    return new CommandContext({
      args: this.args.slice(1),
      flags: this.flags,
      passthrough: this.passthrough,
      cwd: this.cwd,
      io: this.io,
      help: this.help,
      argv: this.argv.slice(1),
    });
  }

  /** First positional, or undefined. */
  get first(): string | undefined {
    return this.args[0];
  }
}
