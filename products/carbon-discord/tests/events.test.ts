// Same coherence check as tests/commands.test.ts, for events: loads every
// registered handler and confirms it actually constructs and carries the
// meta the registry declared for it.

import { describe, expect, test } from "bun:test";
import { Events } from "discord.js";
import { buildEventRegistry } from "../composition/events.ts";

describe("event registry", () => {
  test("every descriptor loads to a BotEvent whose own meta matches", async () => {
    const registry = buildEventRegistry();
    expect(registry.all().length).toBeGreaterThan(0);

    for (const descriptor of registry.all()) {
      const event = await descriptor.load();
      expect(event.meta).toEqual(descriptor.meta);
    }
  });

  test("registers the clientReady handler as a once-only listener", () => {
    const registry = buildEventRegistry();
    const ready = registry.all().find((d) => d.meta.name === Events.ClientReady);

    expect(ready?.meta.once).toBe(true);
  });
});
