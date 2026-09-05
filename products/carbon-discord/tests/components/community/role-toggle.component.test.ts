import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { RoleToggleComponent } from "../../../presentation/components/community/role-toggle.component.ts";

function fakeInteraction(hasRole: boolean): MessageComponentInteraction {
  const role = { id: "role-rel-1", name: "Releases" };

  const rolesCache = new Set<string>();
  if (hasRole) rolesCache.add(role.id);

  const member = {
    roles: {
      cache: {
        has: (id: string) => rolesCache.has(id),
      },
      add: mock((r: any) => {
        rolesCache.add(r.id);
        return Promise.resolve();
      }),
      remove: mock((r: any) => {
        rolesCache.delete(r.id);
        return Promise.resolve();
      }),
    },
  };

  return {
    customId: "role:toggle:Releases",
    member,
    guild: {
      roles: {
        cache: {
          get: (id: string) => (id === "Releases" ? role : undefined),
          find: (fn: any) => (fn(role) ? role : undefined),
        },
      },
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as MessageComponentInteraction;
}

describe("RoleToggleComponent", () => {
  test("adds role when member currently lacks it", async () => {
    const component = new RoleToggleComponent();
    const interaction = fakeInteraction(false);

    await component.execute(interaction);

    expect((interaction.member as any).roles.add).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Added role"),
        ephemeral: true,
      }),
    );
  });

  test("removes role when member already has it", async () => {
    const component = new RoleToggleComponent();
    const interaction = fakeInteraction(true);

    await component.execute(interaction);

    expect((interaction.member as any).roles.remove).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Removed role"),
        ephemeral: true,
      }),
    );
  });
});
