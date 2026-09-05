import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { Component, type ComponentMeta } from "../presentation/framework/component.ts";
import { ComponentRegistry, defineComponent } from "../presentation/framework/component-registry.ts";
import { ComponentRouter } from "../presentation/framework/component-router.ts";

function fakeInteraction(customId: string, replied = false): MessageComponentInteraction {
  return {
    customId,
    replied,
    deferred: false,
    reply: mock(() => Promise.resolve()),
    followUp: mock(() => Promise.resolve()),
  } as unknown as MessageComponentInteraction;
}

class TestButtonComponent extends Component {
  readonly meta: ComponentMeta = { customId: "test:click" };
  async execute(interaction: MessageComponentInteraction): Promise<void> {
    await interaction.reply({ content: "Button clicked!" });
  }
}

class TestPrefixComponent extends Component {
  readonly meta: ComponentMeta = { customId: "role:toggle:", isPrefix: true };
  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const role = interaction.customId.replace("role:toggle:", "");
    await interaction.reply({ content: `Toggled role: ${role}` });
  }
}

describe("ComponentRouter & ComponentRegistry", () => {
  test("routes exact customId match to component", async () => {
    const registry = new ComponentRegistry().register(
      defineComponent({ customId: "test:click" }, async () => new TestButtonComponent()),
    );
    const router = new ComponentRouter(registry);
    const interaction = fakeInteraction("test:click");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Button clicked!" });
  });

  test("routes prefix customId match when isPrefix is true", async () => {
    const registry = new ComponentRegistry().register(
      defineComponent(
        { customId: "role:toggle:", isPrefix: true },
        async () => new TestPrefixComponent(),
      ),
    );
    const router = new ComponentRouter(registry);
    const interaction = fakeInteraction("role:toggle:rust");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Toggled role: rust" });
  });

  test("replies with graceful fallback for unknown component", async () => {
    const router = new ComponentRouter(new ComponentRegistry());
    const interaction = fakeInteraction("unknown:button");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "unknown component: unknown:button",
      ephemeral: true,
    });
  });

  test("catches error during execution and reports it", async () => {
    class FailingComponent extends Component {
      readonly meta: ComponentMeta = { customId: "fail:button" };
      async execute(): Promise<void> {
        throw new Error("Something broke");
      }
    }

    const registry = new ComponentRegistry().register(
      defineComponent({ customId: "fail:button" }, async () => new FailingComponent()),
    );
    const router = new ComponentRouter(registry);
    const interaction = fakeInteraction("fail:button");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "component failed: Something broke",
      ephemeral: true,
    });
  });

  test("disallows registering duplicate exact customIds", () => {
    const registry = new ComponentRegistry();
    registry.register(defineComponent({ customId: "dup" }, async () => new TestButtonComponent()));

    expect(() => {
      registry.register(
        defineComponent({ customId: "dup" }, async () => new TestButtonComponent()),
      );
    }).toThrow('component customId "dup" is already registered');
  });
});
