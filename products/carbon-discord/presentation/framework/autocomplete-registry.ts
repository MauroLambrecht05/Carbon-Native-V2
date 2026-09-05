// The autocomplete registry. Holds lazy descriptors for autocomplete handlers,
// unique by command name.

import type { Autocomplete, AutocompleteMeta } from "./autocomplete.ts";

export type AutocompleteLoader = () => Promise<Autocomplete>;

export interface AutocompleteDescriptor {
  readonly meta: AutocompleteMeta;
  readonly load: AutocompleteLoader;
}

/** Declares an autocomplete handler without importing it. */
export function defineAutocomplete(
  meta: AutocompleteMeta,
  load: AutocompleteLoader,
): AutocompleteDescriptor {
  return { meta, load };
}

export class AutocompleteRegistry {
  private readonly descriptors: AutocompleteDescriptor[] = [];
  private readonly index = new Map<string, AutocompleteDescriptor>();

  register(...descriptors: AutocompleteDescriptor[]): this {
    for (const descriptor of descriptors) {
      const existing = this.index.get(descriptor.meta.commandName);
      if (existing) {
        throw new Error(
          `autocomplete for command "${descriptor.meta.commandName}" is already registered`,
        );
      }
      this.index.set(descriptor.meta.commandName, descriptor);
      this.descriptors.push(descriptor);
    }
    return this;
  }

  resolve(commandName: string): AutocompleteDescriptor | undefined {
    return this.index.get(commandName);
  }

  /** Every registered descriptor, in registration order. */
  all(): readonly AutocompleteDescriptor[] {
    return this.descriptors;
  }
}
