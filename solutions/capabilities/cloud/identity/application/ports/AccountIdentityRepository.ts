import type { AccountChallenge, BrowserSession, FreshAuthBinding, SessionIssue } from "../../domain/entities/AccountIdentity.ts";

export interface AccountIdentityRepository {
  /** Atomically deduplicate, enforce request limits, store challenge and encrypted outbox. */
  queueChallenge(challenge: AccountChallenge): Promise<void>;
  /** Single-use consumption, identity creation and session issuance in one transaction. */
  consumeChallenge(tokenHash: string, browserHash: string, issue: SessionIssue, code?: string, freshAuth?: FreshAuthBinding): Promise<{ session: BrowserSession; redirectPath: string }>;
  findSession(tokenHash: string): Promise<BrowserSession | null>;
  /** Audit and revocation commit together, scoped to the authenticated session. */
  revokeSession(tokenHash: string, csrfHash: string, requestId: string): Promise<void>;
}
