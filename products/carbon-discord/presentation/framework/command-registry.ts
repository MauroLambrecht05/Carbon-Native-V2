// The command registry. Holds descriptors, not commands, so a command's
// implementation is only imported once it is actually invoked: the same
// laziness @carbon/cli's CommandRegistry uses, for the same reason: some
// commands will pull in real weight (an HTTP client, a parser) that an
// interaction for a different command shouldn't pay for.

import type { Command, CommandMeta } from "./command.ts";

export type CommandLoader = () => Promise<Command>;

export interface CommandDescriptor {
  readonly meta: CommandMeta;
  readonly load: CommandLoader;
}

/** Declares a command without importing it. */
export function defineCommand(meta: CommandMeta, load: CommandLoader): CommandDescriptor {
  return { meta, load };
}

export class CommandRegistry {
  private readonly descriptors: CommandDescriptor[] = [];
  private readonly index = new Map<string, CommandDescriptor>();

  register(...descriptors: CommandDescriptor[]): this {
    for (const descriptor of descriptors) {
      const existing = this.index.get(descriptor.meta.name);
      if (existing) {
        throw new Error(`command name "${descriptor.meta.name}" is already registered`);
      }
      this.index.set(descriptor.meta.name, descriptor);
      this.descriptors.push(descriptor);
    }
    return this;
  }

  resolve(name: string): CommandDescriptor | undefined {
    return this.index.get(name);
  }

  /** Every registered descriptor, in registration order. */
  all(): readonly CommandDescriptor[] {
    return this.descriptors;
  }
}
