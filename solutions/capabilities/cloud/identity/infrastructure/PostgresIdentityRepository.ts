import { Organization } from "../domain/entities/Organization.ts";
import { ApiToken, type TokenScope } from "../domain/entities/ApiToken.ts";
import type { IdentityRepository } from "../application/ports/IdentityRepository.ts";

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly sql: Bun.SQL) {}

  async saveOrganization(org: Organization): Promise<void> {
    const p = org.toProps();
    await this.sql`
      INSERT INTO organizations (id, name, created_at) VALUES (${p.id}, ${p.name}, ${p.createdAt})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async saveToken(token: ApiToken): Promise<void> {
    const p = token.toProps();
    await this.sql`
      INSERT INTO api_tokens (id, org_id, scope, token_hash, created_at)
      VALUES (${p.id}, ${p.orgId}, ${p.scope}, ${p.tokenHash}, ${p.createdAt})
    `;
  }

  async findTokenByHash(tokenHash: string): Promise<ApiToken | null> {
    const rows = await this.sql<
      Array<{ id: string; org_id: string; scope: TokenScope; token_hash: string; created_at: Date }>
    >`SELECT * FROM api_tokens WHERE token_hash = ${tokenHash} AND status = 'active'`;
    const row = rows[0];
    if (!row) return null;
    // Usage evidence for the cc_ migration; coarse so verification stays a read most of the time.
    await this.sql`UPDATE api_tokens SET last_used_at = now() WHERE id = ${row.id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
    return ApiToken.fromProps({
      id: row.id,
      orgId: row.org_id,
      scope: row.scope,
      tokenHash: row.token_hash,
      createdAt: new Date(row.created_at),
    });
  }
}
