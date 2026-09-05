import { describe, expect, mock, test } from "bun:test";
import { type ContextMenuCommandInteraction, ApplicationCommandType } from "discord.js";
import {
  ContextMenuCommand,
  type ContextMenuMeta,
} from "../presentation/framework/context-menu.ts";
import {
  ContextMenuRegistry,
  defineContextMenu,
} from "../presentation/framework/context-menu-registry.ts";
import { ContextMenuRouter } from "../presentation/framework/context-menu-router.ts";

function fakeInteraction(commandName: string, replied = false): ContextMenuCommandInteraction {
  return {
    commandName,
    replied,
    deferred: false,
    reply: mock(() => Promise.resolve()),
    followUp: mock(() => Promise.resolve()),
  } as unknown as ContextMenuCommandInteraction;
}

class TestUserContextMenu extends ContextMenuCommand {
  readonly meta: ContextMenuMeta = {
    name: "User Profile",
    type: ApplicationCommandType.User,
  };
  async execute(interaction: ContextMenuCommandInteraction): Promise<void> {
    await interaction.reply({ content: "Inspecting user profile" });
  }
}

describe("ContextMenuRouter & ContextMenuRegistry", () => {
  test("routes context menu command to handler", async () => {
    const registry = new ContextMenuRegistry().register(
      defineContextMenu(
        { name: "User Profile", type: ApplicationCommandType.User },
        async () => new TestUserContextMenu(),
      ),
    );
    const router = new ContextMenuRouter(registry);
    const interaction = fakeInteraction("User Profile");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({ content: "Inspecting user profile" });
  });

  test("replies with graceful fallback for unknown context menu command", async () => {
    const router = new ContextMenuRouter(new ContextMenuRegistry());
    const interaction = fakeInteraction("Nonexistent Action");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "unknown context menu command: Nonexistent Action",
      ephemeral: true,
    });
  });

  test("catches error during execution and reports it", async () => {
    class FailingContextMenu extends ContextMenuCommand {
      readonly meta: ContextMenuMeta = {
        name: "Failing Action",
        type: ApplicationCommandType.Message,
      };
      async execute(): Promise<void> {
        throw new Error("Action failed");
      }
    }

    const registry = new ContextMenuRegistry().register(
      defineContextMenu(
        { name: "Failing Action", type: ApplicationCommandType.Message },
        async () => new FailingContextMenu(),
      ),
    );
    const router = new ContextMenuRouter(registry);
    const interaction = fakeInteraction("Failing Action");

    await router.route(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "context menu command failed: Action failed",
      ephemeral: true,
    });
  });

  test("disallows registering duplicate context menu command names", () => {
    const registry = new ContextMenuRegistry();
    registry.register(
      defineContextMenu(
        { name: "dup", type: ApplicationCommandType.User },
        async () => new TestUserContextMenu(),
      ),
    );

    expect(() => {
      registry.register(
        defineContextMenu(
          { name: "dup", type: ApplicationCommandType.User },
          async () => new TestUserContextMenu(),
        ),
      );
    }).toThrow('context menu command "dup" is already registered');
  });
});
