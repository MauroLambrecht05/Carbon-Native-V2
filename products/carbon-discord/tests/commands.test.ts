// Mirrors carbon-cli's tests/registry.test.ts: loads every registered
// command and checks the registry's metadata agrees with what the loaded
// command itself declares. The duplication between the two exists so
// deploy-commands.ts can read names/descriptions without importing every
// command module. This is the guard that the duplicated copy stays honest.

import { describe, expect, test } from "bun:test";
import { buildCommandRegistry } from "../composition/commands.ts";

describe("command registry", () => {
  test("every descriptor's metadata matches its loaded command's own meta", async () => {
    const registry = buildCommandRegistry();
    expect(registry.all().length).toBeGreaterThan(0);

    for (const descriptor of registry.all()) {
      const command = await descriptor.load();
      expect(command.meta).toEqual(descriptor.meta);
    }
  });

  test("has the ping command", () => {
    const registry = buildCommandRegistry();
    expect(registry.resolve("ping")?.meta.description).toBe("Check that the bot is alive");
  });
});
