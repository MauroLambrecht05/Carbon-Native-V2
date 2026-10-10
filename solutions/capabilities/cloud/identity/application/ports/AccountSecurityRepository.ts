import type { AccountSecurityCommand, AccountSecurityReceipt, AccountSessionSummary, AccountIdentitySummary } from "@carbon/contracts/platform";
import type { SessionIssue } from "../../domain/entities/AccountIdentity.ts";

export interface AccountSecurityMutation {
  readonly tokenHash: string;
  readonly csrfHash: string;
  readonly requestId: string;
  readonly keyDigest: string;
  readonly requestDigest: string;
  readonly expectedRevision: string;
  readonly command: AccountSecurityCommand;
  readonly enrollment?: { id: string; protectedSecret: string };
  readonly recoveryHashes: readonly string[];
  readonly rotation: SessionIssue;
}
export interface AccountSecurityResult {
  readonly receipt: AccountSecurityReceipt;
  readonly disclose: boolean;
  readonly rotated: boolean;
  readonly expiresAt?: string;
}
export interface AccountSecurityRepository {
  listIdentities(tokenHash: string, expectedRevision: string): Promise<readonly AccountIdentitySummary[]>;
  /** Recheck live authorization and revision inside a consistent bounded read. */
  listSessions(tokenHash: string, expectedRevision: string, limit: number, afterId?: string): Promise<readonly AccountSessionSummary[]>;
  /** Authorize, lock, compare revision, mutate, audit and store safe receipt atomically. */
  execute(mutation: AccountSecurityMutation): Promise<AccountSecurityResult>;
}
