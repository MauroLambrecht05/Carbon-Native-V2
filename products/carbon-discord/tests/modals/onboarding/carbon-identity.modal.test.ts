import { describe, expect, mock, test } from "bun:test";
import type { ModalSubmitInteraction } from "discord.js";
import { CarbonIdentityModal } from "../../../presentation/modals/onboarding/carbon-identity.modal.ts";

function fakeModalInteraction(tokenInput: string): ModalSubmitInteraction {
  const devRole = { id: "dev-role", name: "Carbon Developer" };
  const memberRole = { id: "member-role", name: "Member" };

  const member = {
    roles: {
      cache: new Set<string>(),
      add: mock(() => Promise.resolve()),
    },
  };

  return {
    customId: "modal:verify-identity",
    fields: {
      getTextInputValue: mock((field: string) => tokenInput),
    },
    member,
    guild: {
      roles: {
        cache: {
          get: (id: string) => undefined,
          find: (fn: any) => {
            if (fn(devRole)) return devRole;
            if (fn(memberRole)) return memberRole;
            return undefined;
          },
        },
      },
    },
    reply: mock(() => Promise.resolve()),
  } as unknown as ModalSubmitInteraction;
}

describe("CarbonIdentityModal", () => {
  test("rejects invalid token format", async () => {
    const modal = new CarbonIdentityModal();
    const interaction = fakeModalInteraction("invalid_token_123");

    await modal.execute(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Invalid Token Format"),
        ephemeral: true,
      }),
    );
  });

  test("accepts valid cc_ token and assigns developer and member roles", async () => {
    const modal = new CarbonIdentityModal();
    const interaction = fakeModalInteraction("cc_a1b2c3d4e5f6g7h8i9j0k1l2m3");

    await modal.execute(interaction);

    expect((interaction.member as any).roles.add).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Carbon Identity Verified!"),
        ephemeral: true,
      }),
    );
  });
});
