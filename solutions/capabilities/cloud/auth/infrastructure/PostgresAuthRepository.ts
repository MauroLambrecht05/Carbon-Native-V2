import { EndUser } from "../domain/entities/EndUser.ts";
import { MagicLinkToken } from "../domain/entities/MagicLinkToken.ts";
import { Session } from "../domain/entities/Session.ts";
import type { AuthRepository } from "../application/ports/AuthRepository.ts";

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly sql: Bun.SQL) {}

  async findEndUserByEmail(orgId: string, email: string): Promise<EndUser | null> {
    const rows = await this.sql<Array<{ id: string; org_id: string; email: string; created_at: Date }>>`
      SELECT * FROM end_users WHERE org_id = ${orgId} AND email = ${email}
    `;
    const row = rows[0];
    if (!row) return null;
    return EndUser.fromProps({ id: row.id, orgId: row.org_id, email: row.email, createdAt: new Date(row.created_at) });
  }

  async findEndUserById(id: string): Promise<EndUser | null> {
    const rows = await this.sql<Array<{ id: string; org_id: string; email: string; created_at: Date }>>`
      SELECT * FROM end_users WHERE id = ${id}
    `;
    const row = rows[0];
    if (!row) return null;
    return EndUser.fromProps({ id: row.id, orgId: row.org_id, email: row.email, createdAt: new Date(row.created_at) });
  }

  async saveEndUser(user: EndUser): Promise<void> {
    const p = user.toProps();
    await this.sql`
      INSERT INTO end_users (id, org_id, email, created_at) VALUES (${p.id}, ${p.orgId}, ${p.email}, ${p.createdAt})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async saveMagicLinkToken(token: MagicLinkToken): Promise<void> {
    const p = token.toProps();
    await this.sql`
      INSERT INTO magic_link_tokens (id, end_user_id, token_hash, expires_at, consumed_at, created_at)
      VALUES (${p.id}, ${p.endUserId}, ${p.tokenHash}, ${p.expiresAt}, ${p.consumedAt}, ${p.createdAt})
    `;
  }

  async findMagicLinkTokenByHash(tokenHash: string): Promise<MagicLinkToken | null> {
    const rows = await this.sql<
      Array<{
        id: string;
        end_user_id: string;
        token_hash: string;
        expires_at: Date;
        consumed_at: Date | null;
        created_at: Date;
      }>
    >`SELECT * FROM magic_link_tokens WHERE token_hash = ${tokenHash}`;
    const row = rows[0];
    if (!row) return null;
    return MagicLinkToken.fromProps({
      id: row.id,
      endUserId: row.end_user_id,
      tokenHash: row.token_hash,
      expiresAt: new Date(row.expires_at),
      consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
      createdAt: new Date(row.created_at),
    });
  }

  async markMagicLinkTokenConsumed(id: string, consumedAt: Date): Promise<void> {
    await this.sql`UPDATE magic_link_tokens SET consumed_at = ${consumedAt} WHERE id = ${id}`;
  }

  async saveSession(session: Session): Promise<void> {
    const p = session.toProps();
    await this.sql`
      INSERT INTO end_user_sessions (id, end_user_id, org_id, token_hash, expires_at, created_at)
      VALUES (${p.id}, ${p.endUserId}, ${p.orgId}, ${p.tokenHash}, ${p.expiresAt}, ${p.createdAt})
    `;
  }

  async findSessionByHash(tokenHash: string): Promise<Session | null> {
    const rows = await this.sql<
      Array<{ id: string; end_user_id: string; org_id: string; token_hash: string; expires_at: Date; created_at: Date }>
    >`SELECT * FROM end_user_sessions WHERE token_hash = ${tokenHash}`;
    const row = rows[0];
    if (!row) return null;
    return Session.fromProps({
      id: row.id,
      endUserId: row.end_user_id,
      orgId: row.org_id,
      tokenHash: row.token_hash,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    });
  }
}
