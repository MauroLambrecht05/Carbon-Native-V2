// The component registry. Holds lazy descriptors for buttons and select menus.
// Resolves by exact customId or by prefix when isPrefix is set.

import type { Component, ComponentMeta } from "./component.ts";

export type ComponentLoader = () => Promise<Component>;

export interface ComponentDescriptor {
  readonly meta: ComponentMeta;
  readonly load: ComponentLoader;
}

/** Declares a message component handler without importing it. */
export function defineComponent(meta: ComponentMeta, load: ComponentLoader): ComponentDescriptor {
  return { meta, load };
}

export class ComponentRegistry {
  private readonly descriptors: ComponentDescriptor[] = [];
  private readonly exactIndex = new Map<string, ComponentDescriptor>();
  private readonly prefixDescriptors: ComponentDescriptor[] = [];

  register(...descriptors: ComponentDescriptor[]): this {
    for (const descriptor of descriptors) {
      if (descriptor.meta.isPrefix) {
        this.prefixDescriptors.push(descriptor);
      } else {
        const existing = this.exactIndex.get(descriptor.meta.customId);
        if (existing) {
          throw new Error(`component customId "${descriptor.meta.customId}" is already registered`);
        }
        this.exactIndex.set(descriptor.meta.customId, descriptor);
      }
      this.descriptors.push(descriptor);
    }
    return this;
  }

  resolve(customId: string): ComponentDescriptor | undefined {
    const exact = this.exactIndex.get(customId);
    if (exact) return exact;

    // Search prefix descriptors in order of registration
    return this.prefixDescriptors.find((d) => customId.startsWith(d.meta.customId));
  }

  /** Every registered descriptor, in registration order. */
  all(): readonly ComponentDescriptor[] {
    return this.descriptors;
  }
}
