import type { GuildMember, MessageComponentInteraction, Role } from "discord.js";
import { Component, type ComponentMeta } from "../../framework/component.ts";

export class RoleToggleComponent extends Component {
  readonly meta: ComponentMeta = { customId: "role:toggle:", isPrefix: true };

  async execute(interaction: MessageComponentInteraction): Promise<void> {
    const roleIdentifier = interaction.customId.replace("role:toggle:", "").trim();
    const member = interaction.member as GuildMember | null;
    const guild = interaction.guild;

    if (!member || !guild) {
      await interaction.reply({
        content: "Roles can only be selected within a server.",
        ephemeral: true,
      });
      return;
    }

    // Match role by ID or by name
    let role: Role | undefined = guild.roles.cache.get(roleIdentifier);
    if (!role) {
      role = guild.roles.cache.find(
        (r) => r.name.toLowerCase() === roleIdentifier.toLowerCase(),
      );
    }

    if (!role) {
      await interaction.reply({
        content: `Role **${roleIdentifier}** is not yet set up on this server. Please contact an administrator.`,
        ephemeral: true,
      });
      return;
    }

    const hasRole = member.roles.cache.has(role.id);

    if (hasRole) {
      await member.roles.remove(role);
      await interaction.reply({
        content: `❌ Removed role **@${role.name}**.`,
        ephemeral: true,
      });
    } else {
      await member.roles.add(role);
      await interaction.reply({
        content: `✅ Added role **@${role.name}**!`,
        ephemeral: true,
      });
    }
  }
}
