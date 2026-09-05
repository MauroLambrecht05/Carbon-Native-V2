import { describe, expect, mock, test } from "bun:test";
import type { ModalSubmitInteraction } from "discord.js";
import { Modal, type ModalMeta } from "../presentation/framework/modal.ts";
import { ModalRegistry, defineModal } from "../presentation/framework/modal-registry.ts";
import { ModalRouter } from "../presentation/framework/modal-router.ts";

function fakeInteraction(customId: string, replied = false): ModalSubmitInteraction {
  return {
    customId,
    replied,
    deferred: false,
    reply: mock(() => Promise.resolve()),
    followUp: mock(() => Promise.resolve()),
  } as unknown as ModalSubmitInteraction;
}

class TestModal extends Modal {
  readonly meta: ModalMeta = { customId: "feedback:submit" };
  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    await interaction.reply({ content: "Thanks for feedback!" });
  }
}

class TestPrefixModal extends Modal {
  readonly meta: ModalMeta = { customId: "ticket:form:", isPrefix: true };
  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const category = interaction.customId.replace("ticket:form:", "");
    await interaction.reply({ content: `Ticket created for ${category}` });
  }
}

describe("ModalRouter & ModalRegistry", () => {
  test("routes exact customId match to modal handler", async () => {
    const registry = new ModalRegistry().register(
      defineModal({ customId: "feedback:submit" }, async () => new TestModal()),
    );
    const router = new ModalRouter(registry);
    const interaction = fakeInteraction("feedback:submit");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Thanks for feedback!" });
  });

  test("routes prefix customId match when isPrefix is true", async () => {
    const registry = new ModalRegistry().register(
      defineModal({ customId: "ticket:form:", isPrefix: true }, async () => new TestPrefixModal()),
    );
    const router = new ModalRouter(registry);
    const interaction = fakeInteraction("ticket:form:billing");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Ticket created for billing" });
  });

  test("replies with graceful fallback for unknown modal", async () => {
    const router = new ModalRouter(new ModalRegistry());
    const interaction = fakeInteraction("unknown:modal");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "unknown modal: unknown:modal",
      ephemeral: true,
    });
  });

  test("catches error during execution and reports it", async () => {
    class FailingModal extends Modal {
      readonly meta: ModalMeta = { customId: "fail:modal" };
      async execute(): Promise<void> {
        throw new Error("Modal failed");
      }
    }

    const registry = new ModalRegistry().register(
      defineModal({ customId: "fail:modal" }, async () => new FailingModal()),
    );
    const router = new ModalRouter(registry);
    const interaction = fakeInteraction("fail:modal");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "modal failed: Modal failed",
      ephemeral: true,
    });
  });

  test("disallows registering duplicate exact customIds", () => {
    const registry = new ModalRegistry();
    registry.register(defineModal({ customId: "dup" }, async () => new TestModal()));

    expect(() => {
      registry.register(defineModal({ customId: "dup" }, async () => new TestModal()));
    }).toThrow('modal customId "dup" is already registered');
  });
});
