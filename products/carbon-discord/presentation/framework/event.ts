// The BotEvent contract every gateway-event handler implements.
//
// Deliberately not generic over discord.js's ClientEvents the way it looks
// like it should be: parameterizing BotEvent<K> by event name makes each
// concrete event's `handle` signature precise, but then contravariance on
// that parameter makes BotEvent<"clientReady"> NOT assignable to whatever
// supertype composition/events.ts's registry would need to hold a
// heterogeneous list of them. Rather than fight that, the registry-facing
// type is loose (`unknown[]`) and each concrete event narrows its own args
// with a single explicit cast; see ready.event.ts.

import type { ClientEvents } from "discord.js";

export interface EventMeta {
  /** The discord.js event name this handler listens for. */
  readonly name: keyof ClientEvents;
  /** Fire once and detach, rather than on every occurrence (e.g. "clientReady"). */
  readonly once?: boolean;
}

export abstract class BotEvent {
  abstract readonly meta: EventMeta;

  /** Handle one occurrence. Narrow `args` to `meta.name`'s real shape
   * yourself: see ready.event.ts for the pattern. */
  abstract handle(...args: unknown[]): Promise<void>;
}
