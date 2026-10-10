import type { GuildMember, MessageComponentInteraction } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export const DEFAULT_MIN_ACCOUNT_AGE_HOURS = 72;

export class VerifyRulesComponent extends Component {
  readonly meta: ComponentMeta = { customId: "verify:rules" };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const member = interaction.member as GuildMember | null;
    if (!member || !interaction.guild) {
      await interaction.reply({ content: "Rules can only be acknowledged inside the server.", ephemeral: true });
      return;
    }
    const configuredAge = Number(process.env.MIN_ACCOUNT_AGE_HOURS ?? DEFAULT_MIN_ACCOUNT_AGE_HOURS);
    const minAgeHours = Number.isFinite(configuredAge) && configuredAge >= 0 ? configuredAge : DEFAULT_MIN_ACCOUNT_AGE_HOURS;
    const accountAgeHours = (Date.now() - interaction.user.createdTimestamp) / 3_600_000;
    if (accountAgeHours < minAgeHours) {
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id ?? "unknown", action: "verification.rules", outcome: "denied", metadata: { reason: "account_age", accountAgeHours: Math.floor(accountAgeHours) } });
      await interaction.reply({
        content: `Your Discord account must be at least ${minAgeHours} hours old before it can receive community access. A moderator can review legitimate exceptions.`,
        ephemeral: true,
      });
      return;
    }
    const roleId = process.env.MEMBER_ROLE_ID?.trim();
    const role = roleId ? interaction.guild.roles.cache.get(roleId) : undefined;
    if (!role) {
      recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id ?? "unknown", action: "verification.rules", outcome: "failed", metadata: { reason: "member_role_not_configured" } });
      await interaction.reply({ content: "Community access is temporarily unavailable because the member role is not configured.", ephemeral: true });
      return;
    }
    if (member.roles.cache.has(role.id)) {
      await interaction.reply({ content: "You already have community access.", ephemeral: true });
      return;
    }
    await member.roles.add(role);
    recordAudit({ guildId: interaction.guildId, actorId: interaction.user.id ?? "unknown", action: "verification.rules", targetId: role.id, outcome: "allowed" });
    await interaction.reply({ content: "You accepted the server rules and now have community access.", ephemeral: true });
  }
}
