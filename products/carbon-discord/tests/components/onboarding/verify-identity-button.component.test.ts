import { describe, expect, mock, test } from "bun:test";
import type { MessageComponentInteraction } from "discord.js";
import { VerifyIdentityButtonComponent } from "../../../presentation/components/onboarding/verify-identity-button.component.ts";

describe("VerifyIdentityButtonComponent", () => {
  test("shows modal on button click", async () => {
    const component = new VerifyIdentityButtonComponent();
    const interaction = {
      customId: "verify:identity-prompt",
      showModal: mock(() => Promise.resolve()),
    } as unknown as MessageComponentInteraction;

    await component.execute(interaction);

    expect(interaction.showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          custom_id: "modal:verify-identity",
          title: "Link Carbon Identity",
        }),
      }),
    );
  });
});
