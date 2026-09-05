import { describe, expect, mock, test } from "bun:test";
import type { AutocompleteInteraction } from "discord.js";
import { Autocomplete, type AutocompleteMeta } from "../presentation/framework/autocomplete.ts";
import {
  AutocompleteRegistry,
  defineAutocomplete,
} from "../presentation/framework/autocomplete-registry.ts";
import { AutocompleteRouter } from "../presentation/framework/autocomplete-router.ts";

function fakeInteraction(commandName: string, responded = false): AutocompleteInteraction {
  return {
    commandName,
    responded,
    respond: mock(() => {
      responded = true;
      return Promise.resolve();
    }),
  } as unknown as AutocompleteInteraction;
}

class TestAutocomplete extends Autocomplete {
  readonly meta: AutocompleteMeta = { commandName: "plugin" };
  async handle(interaction: AutocompleteInteraction): Promise<void> {
    await interaction.respond([{ name: "carbon-math", value: "carbon-math" }]);
  }
}

describe("AutocompleteRouter & AutocompleteRegistry", () => {
  test("routes autocomplete to handler and sends response", async () => {
    const registry = new AutocompleteRegistry().register(
      defineAutocomplete({ commandName: "plugin" }, async () => new TestAutocomplete()),
    );
    const router = new AutocompleteRouter(registry);
    const interaction = fakeInteraction("plugin");

    await router.route(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: "carbon-math", value: "carbon-math" },
    ]);
  });

  test("responds with empty array for unregistered autocomplete command to prevent hanging UI", async () => {
    const router = new AutocompleteRouter(new AutocompleteRegistry());
    const interaction = fakeInteraction("unknown");

    await router.route(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  test("catches handler error and responds with empty array", async () => {
    class FailingAutocomplete extends Autocomplete {
      readonly meta: AutocompleteMeta = { commandName: "failing" };
      async handle(): Promise<void> {
        throw new Error("Autocomplete lookup failed");
      }
    }

    const registry = new AutocompleteRegistry().register(
      defineAutocomplete({ commandName: "failing" }, async () => new FailingAutocomplete()),
    );
    const router = new AutocompleteRouter(registry);
    const interaction = fakeInteraction("failing");

    await router.route(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });

  test("disallows duplicate registration for the same commandName", () => {
    const registry = new AutocompleteRegistry();
    registry.register(
      defineAutocomplete({ commandName: "dup" }, async () => new TestAutocomplete()),
    );

    expect(() => {
      registry.register(
        defineAutocomplete({ commandName: "dup" }, async () => new TestAutocomplete()),
      );
    }).toThrow('autocomplete for command "dup" is already registered');
  });
});
