import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { VerifyRulesComponent } from "../../../presentation/components/onboarding/verify-rules.component.ts";

function fakeInteraction(options: {
  accountAgeHours: number;
  alreadyHasRole?: boolean;
}): MessageComponentInteraction {
  const createdTimestamp = Date.now() - options.accountAgeHours * 60 * 60 * 1000;
  const roleId = "role-member-123";

  const memberRolesCache = new Set<string>();
  if (options.alreadyHasRole) {
    memberRolesCache.add(roleId);
  }

  const member = {
    roles: {
      cache: {
        has: (id: string) => memberRolesCache.has(id),
      },
      add: mock((role: any) => {
        memberRolesCache.add(role.id);
        return Promise.resolve();
      }),
    },
  };

  return {
    customId: "verify:rules",
    user: { createdTimestamp },
    member,
    guild: {
      roles: {
        cache: {
          get: (id: string) => (id === roleId ? { id, name: "Member" } : undefined),
          find: (fn: any) => ({ id: roleId, name: "Member" }),
        },
      },
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as MessageComponentInteraction;
}

describe("VerifyRulesComponent", () => {
  test("blocks accounts created too recently (anti-raid trigger)", async () => {
    const component = new VerifyRulesComponent();
    // 10 hours old, below 72h default
    const interaction = fakeInteraction({ accountAgeHours: 10 });

    await component.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Anti-Raid Protection"),
        ephemeral: true,
      }),
    );
  });

  test("verifies mature accounts and adds member role", async () => {
    const component = new VerifyRulesComponent();
    // 100 hours old, above 72h default
    const interaction = fakeInteraction({ accountAgeHours: 100 });

    await component.execute(interaction);

    expect((interaction.member as any).roles.add).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Verification Complete!"),
        ephemeral: true,
      }),
    );
  });

  test("informs member if they already hold the role", async () => {
    const component = new VerifyRulesComponent();
    const interaction = fakeInteraction({ accountAgeHours: 100, alreadyHasRole: true });

    await component.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "You are already verified as a member!",
      ephemeral: true,
    });
  });
});
