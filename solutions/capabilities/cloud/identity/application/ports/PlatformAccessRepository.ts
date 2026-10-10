import type { AccessSnapshot, Scope } from "@carbon/contracts/platform";
import type { OrganizationActor } from "./OrganizationRepository.ts";

export interface PlatformAccessRepository {
  resolve(actor: OrganizationActor, scope: Scope): Promise<AccessSnapshot>;
}
