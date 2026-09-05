import { EndUser } from "../domain/entities/EndUser.ts";
import { MagicLinkToken } from "../domain/entities/MagicLinkToken.ts";
import { Session } from "../domain/entities/Session.ts";
import type { AuthRepository } from "../application/ports/AuthRepository.ts";

export class InMemoryAuthRepository implements AuthRepository {
  private readonly endUsers = new Map<string, EndUser>();
  private readonly magicLinkTokens = new Map<string, MagicLinkToken>();
  private readonly sessions = new Map<string, Session>();

  async findEndUserByEmail(orgId: string, email: string): Promise<EndUser | null> {
    for (const user of this.endUsers.values()) {
      if (user.orgId === orgId && user.email === email) return user;
    }
    return null;
  }

  async findEndUserById(id: string): Promise<EndUser | null> {
    return this.endUsers.get(id) ?? null;
  }

  async saveEndUser(user: EndUser): Promise<void> {
    this.endUsers.set(user.id, user);
  }

  async saveMagicLinkToken(token: MagicLinkToken): Promise<void> {
    this.magicLinkTokens.set(token.toProps().tokenHash, token);
  }

  async findMagicLinkTokenByHash(tokenHash: string): Promise<MagicLinkToken | null> {
    return this.magicLinkTokens.get(tokenHash) ?? null;
  }

  async markMagicLinkTokenConsumed(id: string, consumedAt: Date): Promise<void> {
    for (const [hash, token] of this.magicLinkTokens) {
      if (token.id === id) {
        this.magicLinkTokens.set(hash, MagicLinkToken.fromProps({ ...token.toProps(), consumedAt }));
        return;
      }
    }
  }

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.toProps().tokenHash, session);
  }

  async findSessionByHash(tokenHash: string): Promise<Session | null> {
    return this.sessions.get(tokenHash) ?? null;
  }
}
