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
    >`SELECT * FROM api_tokens WHERE token_hash = ${tokenHash}`;
    const row = rows[0];
    if (!row) return null;
    return ApiToken.fromProps({
      id: row.id,
      orgId: row.org_id,
      scope: row.scope,
      tokenHash: row.token_hash,
      createdAt: new Date(row.created_at),
    });
  }
}
