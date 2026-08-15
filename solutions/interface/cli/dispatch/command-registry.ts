// The command registry.
//
// Holds *descriptors*, not commands. A descriptor is metadata plus a loader,
// so the registry can answer "what commands exist, what do they do, what are
// their aliases" without importing a single implementation.
//
// This is the whole reason `carbon --help` is fast. The build commands pull in
// vite, rollup and babel transitively; evaluating them costs more than
// everything else the CLI does on a help invocation. V1 got this right with a
// hand-written switch of dynamic imports — this keeps the property while
// making the command list introspectable rather than trapped in a switch.

import type { Command, CommandMeta } from "../kernel/command.ts";

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
      const names = [descriptor.meta.name, ...(descriptor.meta.aliases ?? [])];
      for (const name of names) {
        const existing = this.index.get(name);
        if (existing) {
          // A silent overwrite here shows up much later as "why is `build`
          // running the wrong thing", so it fails at registration instead.
          throw new Error(
            `command name "${name}" is claimed by both "${existing.meta.name}" and "${descriptor.meta.name}"`,
          );
        }
        this.index.set(name, descriptor);
      }
      this.descriptors.push(descriptor);
    }
    return this;
  }

  /** Descriptor for a name or alias. */
  resolve(name: string): CommandDescriptor | undefined {
    return this.index.get(name);
  }

  /** Every registered descriptor, in registration order. */
  all(): readonly CommandDescriptor[] {
    return this.descriptors;
  }

  /** Descriptors shown in the command list. */
  visible(): readonly CommandDescriptor[] {
    return this.descriptors.filter((d) => !d.meta.hidden);
  }

  /**
   * Names close enough to `name` to be worth suggesting after a typo.
   * Levenshtein distance <= 2, which catches transpositions and a missing or
   * doubled character without proposing something unrelated.
   */
  suggest(name: string): string[] {
    return [...this.index.keys()]
      .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
      .filter(({ distance }) => distance <= 2)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map(({ candidate }) => candidate);
  }
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}
