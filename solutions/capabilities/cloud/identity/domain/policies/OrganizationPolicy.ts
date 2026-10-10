import type { OrganizationCommand, Role } from "@carbon/contracts/platform";
import { PlatformFault } from "@carbon/contracts/platform";
import { ROLE_PERMISSIONS } from "./PlatformAuthorization.ts";

export function authorizeInvitationRole(role: Role, targetRole?: Role): void {
  if (!ROLE_PERMISSIONS[role].includes("members.manage") || (targetRole && !ROLE_PERMISSIONS[targetRole].every(permission => ROLE_PERMISSIONS[role].includes(permission)))) {
    throw new PlatformFault("forbidden", "You cannot delegate this organization role");
  }
}

export function authorizeOrganizationCommand(role: Role, command: OrganizationCommand, targetRole?: Role): void {
  if (command.kind === "leave" || command.kind === "ownership-accept") return;
  if (["policy", "ownership-propose", "ownership-cancel", "delete", "delete-cancel"].includes(command.kind)) {
    if (role !== "Owner") throw new PlatformFault("forbidden", "An organization owner is required");
  } else if (!ROLE_PERMISSIONS[role].includes("members.manage")) throw new PlatformFault("forbidden", "Membership management is not allowed");
  if ((command.kind === "member-role" || command.kind === "member-revoke") && targetRole === "Owner") throw new PlatformFault("conflict", "Use accepted ownership transfer to change an owner");
  if (command.kind === "member-access" && targetRole === "Owner" && role !== "Owner") throw new PlatformFault("forbidden", "Only an owner may change another owner's access");
  if (command.kind === "member-role" && !ROLE_PERMISSIONS[command.role].every(permission => ROLE_PERMISSIONS[role].includes(permission))) throw new PlatformFault("forbidden", "You cannot delegate permissions you do not have");
}
