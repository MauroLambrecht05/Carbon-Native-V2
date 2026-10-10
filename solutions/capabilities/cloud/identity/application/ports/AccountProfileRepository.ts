import type { AccountProfileCommand, AccountSecurityReceipt } from "@carbon/contracts/platform";
import type { FreshAuthBinding, SessionIssue } from "../../domain/entities/AccountIdentity.ts";

export interface ProfileMutation {
  readonly binding: FreshAuthBinding;
  readonly expectedRevision: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly requestId: string;
  readonly command: AccountProfileCommand;
  readonly emailChange?: { id: string; tokenHash: string; browserHash: string; expiresAt: Date; protectedMessage: string; rateKeys: readonly string[] };
}
export interface EmailChangeCompletion {
  readonly binding: FreshAuthBinding;
  readonly previousEmail: string;
  readonly tokenHash: string;
  readonly browserHash: string;
  readonly code?: string;
  readonly issue: SessionIssue;
  readonly notice: { id: string; protectedMessage: string };
}
export interface AccountProfileRepository {
  pendingEmail(binding: FreshAuthBinding, expectedRevision: string): Promise<{ email: string; expiresAt: string } | null>;
  execute(mutation: ProfileMutation): Promise<AccountSecurityReceipt>;
  completeEmail(input: EmailChangeCompletion): Promise<{ expiresAt: string }>;
}
