import type { GuildMember, MessageComponentInteraction } from "discord.js";
import { recordAudit } from "../../../infrastructure/state/audit-log.ts";
import { Component, type ComponentMeta } from "../../framework/component.ts";

const ROLE_CONFIGURATION: Readonly<Record<string, string>> = {
  announcements: "ANNOUNCEMENTS_ROLE_ID",
  releases: "RELEASES_ROLE_ID",
  preview: "PREVIEW_ROLE_ID",
  security: "SECURITY_ROLE_ID",
  events: "EVENTS_ROLE_ID",
};

export class RoleToggleComponent extends Component {
  readonly meta: ComponentMeta = { customId: "role:toggle:", isPrefix: true };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const key = interaction.customId.replace("role:toggle:", "").trim().toLowerCase();
    const envName = ROLE_CONFIGURATION[key];
    const roleId = envName ? process.env[envName]?.trim() : undefined;
    const member = interaction.member as GuildMember | null;
    const role = roleId ? interaction.guild?.roles.cache.get(roleId) : undefined;
    if (!member || !interaction.guild) {
      await interaction.reply({ content: "Notification preferences can only be changed inside the server.", ephemeral: true });
      return;
    }
    if (!role) {
      await interaction.reply({ content: "That notification preference is not configured. Please contact a moderator.", ephemeral: true });
      return;
    }

    const remove = member.roles.cache.has(role.id);
    if (remove) await member.roles.remove(role);
    else await member.roles.add(role);
    recordAudit({
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      action: "preference.role",
      targetId: role.id,
      outcome: "allowed",
      metadata: { preference: key, enabled: !remove },
    });
    await interaction.reply({ content: `${remove ? "Disabled" : "Enabled"} **${role.name}** notifications.`, ephemeral: true });
  }
}
