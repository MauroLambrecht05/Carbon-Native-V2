// Every gateway-event handler the bot has, in one place, the same shape as
// composition/commands.ts, for the same reason: metadata declared here,
// implementation behind a lazy `load()`.

import { Events } from "discord.js";
import { EventRegistry, defineEvent } from "../presentation/framework/event-registry.ts";

export function buildEventRegistry(): EventRegistry {
  return new EventRegistry().register(
    defineEvent(
      { name: Events.ClientReady, once: true },
      async () => new (await import("../presentation/events/diagnostics/ready.event.ts")).ReadyEvent(),
    ),
    defineEvent(
      { name: Events.GuildMemberAdd },
      async () =>
        new (await import("../presentation/events/onboarding/guild-member-add.event.ts")).GuildMemberAddEvent(),
    ),
    defineEvent(
      { name: Events.MessageReactionAdd },
      async () =>
        new (await import("../presentation/events/community/starboard.event.ts")).StarboardEvent(),
    ),
    defineEvent(
      { name: Events.ThreadCreate },
      async () =>
        new (await import("../presentation/events/community/thread-create.event.ts")).ThreadCreateEvent(),
    ),
  );
}
