import type { GuildMember, MessageComponentInteraction, Role } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export const DEFAULT_MIN_ACCOUNT_AGE_HOURS = 72;

export class VerifyRulesComponent extends Component {
  readonly meta: ComponentMeta = { customId: "verify:rules" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const member = interaction.member as GuildMember | null;
    if (!member) {
      await interaction.reply({
        content: "Verification must be performed within a server.",
        ephemeral: true,
      });
      return;
    }

    // Anti-raid check: ensure account is old enough
    const minAgeHours = Number(process.env.MIN_ACCOUNT_AGE_HOURS) || DEFAULT_MIN_ACCOUNT_AGE_HOURS;
    const accountAgeMs = Date.now() - interaction.user.createdTimestamp;
    const minAgeMs = minAgeHours * 60 * 60 * 1000;

    if (accountAgeMs < minAgeMs) {
      const hoursOld = Math.floor(accountAgeMs / (1000 * 60 * 60));
      await interaction.reply({
        content:
          `🛡️ **Anti-Raid Protection**: Your Discord account is only ${hoursOld} hours old. ` +
          `Accounts must be at least ${minAgeHours} hours old to quick-verify. ` +
          `Alternatively, you can click **Link Carbon Identity** to authenticate with your Carbon Cloud developer token.`,
        ephemeral: true,
      });
      return;
    }

    const guild = interaction.guild;
    const targetRoleId = process.env.MEMBER_ROLE_ID;
    let role: Role | undefined;

    if (guild) {
      if (targetRoleId) {
        role = guild.roles.cache.get(targetRoleId);
      } else {
        role = guild.roles.cache.find((r) => r.name.toLowerCase() === "member");
      }
    }

    if (role && member.roles && "add" in member.roles) {
      if (member.roles.cache?.has(role.id)) {
        await interaction.reply({
          content: "You are already verified as a member!",
          ephemeral: true,
        });
        return;
      }
      await member.roles.add(role);
    }

    await interaction.reply({
      content:
        "✅ **Verification Complete!** You have accepted the server rules and received the **@Member** role. Full channels are now unlocked. Welcome to Carbon Native!",
      ephemeral: true,
    });
  }
}
