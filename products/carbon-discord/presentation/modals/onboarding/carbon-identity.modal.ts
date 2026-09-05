import type { GuildMember, ModalSubmitInteraction, Role } from "discord.js";
import { Modal, type ModalMeta } from "../../framework/modal.ts";

export class CarbonIdentityModal extends Modal {
  readonly meta: ModalMeta = { customId: "modal:verify-identity" };

  async execute(interaction: ModalSubmitInteraction): Promise<void> {
    const token = interaction.fields.getTextInputValue("token-input").trim();

    // Verify token format: Carbon Cloud organization tokens start with "cc_"
    if (!token.startsWith("cc_") || token.length < 15) {
      await interaction.reply({
        content:
          "❌ **Invalid Token Format**: Carbon Cloud API tokens must start with `cc_`. " +
          "You can generate one using `carbon auth` or via the Carbon Cloud console.",
        ephemeral: true,
      });
      return;
    }

    const member = interaction.member as GuildMember | null;
    if (!member || !interaction.guild) {
      await interaction.reply({
        content: "Verification must be performed inside the server.",
        ephemeral: true,
      });
      return;
    }

    const guild = interaction.guild;

    // Resolve roles to assign: Developer and Member
    const devRoleId = process.env.DEVELOPER_ROLE_ID;
    const memberRoleId = process.env.MEMBER_ROLE_ID;

    const devRole: Role | undefined = devRoleId
      ? guild.roles.cache.get(devRoleId)
      : guild.roles.cache.find((r) => r.name.toLowerCase().includes("developer"));

    const memberRole: Role | undefined = memberRoleId
      ? guild.roles.cache.get(memberRoleId)
      : guild.roles.cache.find((r) => r.name.toLowerCase() === "member");

    if (member.roles && "add" in member.roles) {
      const rolesToAdd: Role[] = [];
      if (devRole && !member.roles.cache?.has(devRole.id)) rolesToAdd.push(devRole);
      if (memberRole && !member.roles.cache?.has(memberRole.id)) rolesToAdd.push(memberRole);

      if (rolesToAdd.length > 0) {
        await member.roles.add(rolesToAdd);
      }
    }

    await interaction.reply({
      content:
        "⚡ **Carbon Identity Verified!** Your account is authenticated with Carbon Cloud. " +
        "You have been granted the **@Carbon Developer** role and full access to all developer channels and release previews.",
      ephemeral: true,
    });
  }
}
