// argv in, exit code out.
//
// The single place that decides what runs. Everything it needs — routing,
// aliases, help, typo suggestions, error rendering — comes from the registry,
// so adding a command is one registration and nothing here changes.

import { Command, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type ExitCode } from "./command.ts";
import { CommandContext } from "./command-context.ts";
import { parseArgv } from "./flags.ts";
import { HelpRenderer, isCommandGroup } from "./help.ts";
import type { Io } from "./io-port.ts";
import type { CommandRegistry } from "./command-registry.ts";

const HELP_TOKENS = new Set(["help", "--help", "-h"]);
const VERSION_TOKENS = new Set(["--version", "-v", "version"]);

export interface DispatcherOptions {
  readonly registry: CommandRegistry;
  readonly io: Io;
  readonly binary: string;
  readonly version: string;
  readonly cwd?: string;
}

export class Dispatcher {
  private readonly registry: CommandRegistry;
  private readonly io: Io;
  private readonly help: HelpRenderer;
  private readonly cwd: string;
  private readonly binary: string;
  private readonly version: string;

  constructor(options: DispatcherOptions) {
    this.registry = options.registry;
    this.io = options.io;
    this.cwd = options.cwd ?? process.cwd();
    this.binary = options.binary;
    this.version = options.version;
    this.help = new HelpRenderer(options.registry, options.io, options.binary, options.version);
  }

  /** `argv` is the user's arguments — process.argv already sliced. */
  async run(argv: readonly string[]): Promise<ExitCode> {
    const [name, ...rest] = argv;

    if (name === undefined || HELP_TOKENS.has(name)) {
      return this.runHelp(rest);
    }

    if (VERSION_TOKENS.has(name)) {
      this.io.raw(`${this.binary} ${this.version}`);
      return EXIT_OK;
    }

    const descriptor = this.registry.resolve(name);
    if (!descriptor) {
      this.io.error(`unknown command: ${this.io.c.red(name)}`);
      const suggestions = this.registry.suggest(name);
      if (suggestions.length) {
        this.io.raw(`  did you mean ${suggestions.map((s) => this.io.c.cyan(s)).join(", ")}?`);
      }
      this.io.raw(this.help.renderRoot());
      return EXIT_USAGE;
    }

    // `carbon build --help` prints help without loading the build pipeline.
    if (rest.some((token) => HELP_TOKENS.has(token)) && !isGroupName(rest)) {
      this.io.raw(this.help.renderCommand(descriptor.meta));
      return EXIT_OK;
    }

    if (descriptor.meta.deprecated) {
      this.io.warn(`${descriptor.meta.name} is deprecated: ${descriptor.meta.deprecated}`);
    }

    const command = await descriptor.load();
    const ctx = this.contextFor(command, rest);

    const problem = command.validate?.(ctx);
    if (problem) {
      this.io.error(problem);
      this.io.raw(this.help.renderCommand(command.meta));
      return EXIT_USAGE;
    }

    try {
      return await command.execute(ctx);
    } catch (error: any) {
      this.io.error(error?.message ?? String(error));
      if (process.env.CARBON_DEBUG && error?.stack) {
        this.io.raw(this.io.c.dim(error.stack));
      }
      return EXIT_FAILURE;
    }
  }

  /** `carbon help`, `carbon help <command>`. */
  private async runHelp(rest: readonly string[]): Promise<ExitCode> {
    const target = rest.find((token) => !token.startsWith("-"));
    if (!target) {
      this.io.raw(this.help.renderRoot());
      return EXIT_OK;
    }

    const descriptor = this.registry.resolve(target);
    if (!descriptor) {
      this.io.error(`unknown command: ${this.io.c.red(target)}`);
      return EXIT_USAGE;
    }

    // A group's subcommand help needs the instance, so this is the one help
    // path that loads. `carbon --help` never does.
    const command = await descriptor.load();
    this.io.raw(
      isCommandGroup(command)
        ? this.help.renderGroup(command)
        : this.help.renderCommand(command.meta),
    );
    return EXIT_OK;
  }

  private contextFor(command: Command, rest: readonly string[]): CommandContext {
    const parsed = parseArgv(rest, command.meta.flags ?? []);
    return new CommandContext({
      args: parsed.args,
      flags: parsed.flags,
      passthrough: parsed.passthrough,
      cwd: this.cwd,
      io: this.io,
      help: this.help,
      argv: rest,
    });
  }
}

/**
 * `carbon plugin --help` should reach the group so it can list subcommands,
 * rather than being answered by the flat command renderer. A leading
 * positional means a subcommand was named, so the group handles it.
 */
function isGroupName(rest: readonly string[]): boolean {
  return rest.length > 0 && !rest[0].startsWith("-");
}
