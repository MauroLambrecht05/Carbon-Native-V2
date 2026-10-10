import { PermissionFlagsBits, type GuildMember, type GuildMemberRoleManager } from "discord.js";
import { recordAudit } from "../../infrastructure/state/audit-log.ts";

export type StaffCapability = "support" | "moderation" | "community" | "release";

interface AuthorizableInteraction {
  readonly guildId?: string | null;
  readonly user?: { readonly id: string };
  readonly member?: unknown;
  readonly memberPermissions?: { has(permission: bigint): boolean } | null;
}

interface ReplyingInteraction extends AuthorizableInteraction {
  reply(options: { content: string; ephemeral: true }): Promise<unknown>;
}

const ROLE_ENV: Record<StaffCapability, string> = {
  support: "SUPPORT_ROLE_IDS",
  moderation: "MODERATOR_ROLE_IDS",
  community: "COMMUNITY_MANAGER_ROLE_IDS",
  release: "RELEASE_MANAGER_ROLE_IDS",
};

function configuredRoleIds(capability: StaffCapability): Set<string> {
  return new Set((process.env[ROLE_ENV[capability]] ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

export function hasStaffCapability(interaction: AuthorizableInteraction, capability: StaffCapability): boolean {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  const configured = configuredRoleIds(capability);
  if (configured.size === 0) return false;
  const roles = (interaction.member as GuildMember | null)?.roles as GuildMemberRoleManager | undefined;
  return Boolean(roles?.cache?.some((role) => configured.has(role.id)));
}

export async function requireStaff(interaction: ReplyingInteraction, capability: StaffCapability, action: string): Promise<boolean> {
  const allowed = hasStaffCapability(interaction, capability);
  if (allowed) return true;
  recordAudit({ guildId: interaction.guildId, actorId: interaction.user?.id ?? "unknown", action, outcome: "denied", metadata: { capability } });
  await interaction.reply({ content: "This action is restricted to authorized Carbon staff.", ephemeral: true });
  return false;
}
