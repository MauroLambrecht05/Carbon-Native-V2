// The modal registry. Holds lazy descriptors for modal submit handlers.

import type { Modal, ModalMeta } from "./modal.ts";

export type ModalLoader = () => Promise<Modal>;

export interface ModalDescriptor {
  readonly meta: ModalMeta;
  readonly load: ModalLoader;
}

/** Declares a modal submit handler without importing it. */
export function defineModal(meta: ModalMeta, load: ModalLoader): ModalDescriptor {
  return { meta, load };
}

export class ModalRegistry {
  private readonly descriptors: ModalDescriptor[] = [];
  private readonly exactIndex = new Map<string, ModalDescriptor>();
  private readonly prefixDescriptors: ModalDescriptor[] = [];

  register(...descriptors: ModalDescriptor[]): this {
    for (const descriptor of descriptors) {
      if (descriptor.meta.isPrefix) {
        this.prefixDescriptors.push(descriptor);
      } else {
        const existing = this.exactIndex.get(descriptor.meta.customId);
        if (existing) {
          throw new Error(`modal customId "${descriptor.meta.customId}" is already registered`);
        }
        this.exactIndex.set(descriptor.meta.customId, descriptor);
      }
      this.descriptors.push(descriptor);
    }
    return this;
  }

  resolve(customId: string): ModalDescriptor | undefined {
    const exact = this.exactIndex.get(customId);
    if (exact) return exact;

    return this.prefixDescriptors.find((d) => customId.startsWith(d.meta.customId));
  }

  /** Every registered descriptor, in registration order. */
  all(): readonly ModalDescriptor[] {
    return this.descriptors;
  }
}
