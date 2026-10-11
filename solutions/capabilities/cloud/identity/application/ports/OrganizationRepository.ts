import type { MemberAccess, OrganizationCommand, OrganizationCreate, OrganizationMember, OrganizationReceipt, OrganizationSummary, OwnershipTransfer } from "@carbon/contracts/platform";
import type { FreshAuthBinding } from "../../domain/entities/AccountIdentity.ts";

/**
 * Who a request speaks for. Normally a browser session. With `delegation`, a device or personal credential acting
 * as its account: `sessionId` is then the credential's ID and `tokenHash` the credential's, there is no CSRF
 * token, and the actor can do no more than the credential was given.
 */
export interface OrganizationActor extends FreshAuthBinding { readonly permissionRevision: string; readonly delegation?: DelegationKind }
export type DelegationKind = 'device' | 'personal';
export interface OrganizationMutation {
  readonly actor: OrganizationActor;
  readonly orgId?: string;
  readonly command: OrganizationCommand | (OrganizationCreate & { kind: "create" });
  readonly expectedRevision?: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly requestId: string;
}
export interface OrganizationRepository {
  list(actor: OrganizationActor, limit: number, afterId?: string): Promise<readonly OrganizationSummary[]>;
  get(actor: OrganizationActor, orgId: string): Promise<{ organization: OrganizationSummary; transfer: OwnershipTransfer | null }>;
  members(actor: OrganizationActor, orgId: string, revision: string, limit: number, afterId?: string): Promise<readonly OrganizationMember[]>;
  memberAccess(actor: OrganizationActor, orgId: string, membershipId: string): Promise<MemberAccess>;
  execute(mutation: OrganizationMutation): Promise<OrganizationReceipt>;
}
