// The event registry. Shaped like CommandRegistry (lazy descriptors, a
// `defineX` builder) but deliberately NOT the same class: CommandRegistry
// rejects a duplicate name because Discord enforces that a command name
// maps to exactly one handler. Nothing enforces that about a gateway event:
// two unrelated features can both listen for "guildMemberAdd" and both
// should fire, so this is a plain list composition/entrypoint.ts iterates
// to attach one client.on/once per descriptor, not a lookup table.

import type { BotEvent, EventMeta } from "./event.ts";

export type EventLoader = () => Promise<BotEvent>;

export interface EventDescriptor {
  readonly meta: EventMeta;
  readonly load: EventLoader;
}

/** Declares an event handler without importing it. */
export function defineEvent(meta: EventMeta, load: EventLoader): EventDescriptor {
  return { meta, load };
}

export class EventRegistry {
  private readonly descriptors: EventDescriptor[] = [];

  register(...descriptors: EventDescriptor[]): this {
    this.descriptors.push(...descriptors);
    return this;
  }

  /** Every registered descriptor, in registration order. */
  all(): readonly EventDescriptor[] {
    return this.descriptors;
  }
}
