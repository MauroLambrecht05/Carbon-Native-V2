import type { EndUser } from "../../domain/entities/EndUser.ts";
import type { MagicLinkToken } from "../../domain/entities/MagicLinkToken.ts";
import type { Session } from "../../domain/entities/Session.ts";

export interface AuthRepository {
  findEndUserByEmail(orgId: string, email: string): Promise<EndUser | null>;
  findEndUserById(id: string): Promise<EndUser | null>;
  saveEndUser(user: EndUser): Promise<void>;

  saveMagicLinkToken(token: MagicLinkToken): Promise<void>;
  findMagicLinkTokenByHash(tokenHash: string): Promise<MagicLinkToken | null>;
  /** Marks the token used — a second consume attempt on the same plaintext must fail even if it hasn't expired yet. */
  markMagicLinkTokenConsumed(id: string, consumedAt: Date): Promise<void>;

  saveSession(session: Session): Promise<void>;
  findSessionByHash(tokenHash: string): Promise<Session | null>;
}
