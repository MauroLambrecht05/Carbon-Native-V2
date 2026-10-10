import type { InvitationCommand, InvitationPreview, InvitationReceipt, InvitationSummary } from "@carbon/contracts/platform";
import type { OrganizationActor } from "./OrganizationRepository.ts";

export interface InvitationMutation {
  readonly actor: OrganizationActor;
  readonly orgId: string;
  readonly command: InvitationCommand;
  readonly expectedRevision: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly requestId: string;
  readonly delivery?: { readonly id: string; readonly tokenHash: string; readonly protectedMessage: string; readonly expiresAt: Date; readonly rateKeys: readonly string[] };
}
export interface InvitationAcceptance {
  readonly actor: OrganizationActor;
  readonly tokenHash: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly requestId: string;
}
export interface OrganizationInvitationsRepository {
  list(actor: OrganizationActor, orgId: string, revision: string, limit: number, afterId?: string): Promise<readonly InvitationSummary[]>;
  destination(actor: OrganizationActor, orgId: string, invitationId: string): Promise<string>;
  execute(input: InvitationMutation): Promise<InvitationReceipt>;
  preview(actor: OrganizationActor, tokenHash: string): Promise<InvitationPreview>;
  accept(input: InvitationAcceptance): Promise<InvitationReceipt>;
}
