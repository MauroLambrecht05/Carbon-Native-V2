// Mirrors carbon-cli's tests/registry.test.ts: loads every registered
// command and checks the registry's metadata agrees with what the loaded
// command itself declares. The duplication between the two exists so
// deploy-commands.ts can read names/descriptions without importing every
// command module. This is the guard that the duplicated copy stays honest.

import { describe, expect, test } from "bun:test";
import { SlashCommandBuilder } from "discord.js";
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

  test("produces Discord-valid required option ordering", async () => {
    for (const descriptor of buildCommandRegistry().all()) {
      const command = await descriptor.load();
      const builder = new SlashCommandBuilder()
        .setName(descriptor.meta.name)
        .setDescription(descriptor.meta.description);
      command.configureBuilder?.(builder);
      const options = builder.toJSON().options ?? [];
      let optionalSeen = false;
      for (const option of options) {
        if (option.required) expect(optionalSeen).toBe(false);
        else optionalSeen = true;
      }
    }
  });
});
