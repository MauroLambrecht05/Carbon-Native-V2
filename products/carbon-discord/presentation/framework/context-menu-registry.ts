// The context-menu command registry. Holds lazy descriptors for user and
// message context menu commands, unique by command name.

import type { ContextMenuCommand, ContextMenuMeta } from "./context-menu.ts";

export type ContextMenuLoader = () => Promise<ContextMenuCommand>;

export interface ContextMenuDescriptor {
  readonly meta: ContextMenuMeta;
  readonly load: ContextMenuLoader;
}

/** Declares a context menu command without importing it. */
export function defineContextMenu(
  meta: ContextMenuMeta,
  load: ContextMenuLoader,
): ContextMenuDescriptor {
  return { meta, load };
}

export class ContextMenuRegistry {
  private readonly descriptors: ContextMenuDescriptor[] = [];
  private readonly index = new Map<string, ContextMenuDescriptor>();

  register(...descriptors: ContextMenuDescriptor[]): this {
    for (const descriptor of descriptors) {
      const existing = this.index.get(descriptor.meta.name);
      if (existing) {
        throw new Error(`context menu command "${descriptor.meta.name}" is already registered`);
      }
      this.index.set(descriptor.meta.name, descriptor);
      this.descriptors.push(descriptor);
    }
    return this;
  }

  resolve(name: string): ContextMenuDescriptor | undefined {
    return this.index.get(name);
  }

  /** Every registered descriptor, in registration order. */
  all(): readonly ContextMenuDescriptor[] {
    return this.descriptors;
  }
}
