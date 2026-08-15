import { Organization } from "../domain/entities/Organization.ts";
import { ApiToken } from "../domain/entities/ApiToken.ts";
import type { IdentityRepository } from "../application/ports/IdentityRepository.ts";

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly orgs = new Map<string, Organization>();
  private readonly tokensByHash = new Map<string, ApiToken>();

  async saveOrganization(org: Organization): Promise<void> {
    this.orgs.set(org.id, org);
  }

  async saveToken(token: ApiToken): Promise<void> {
    this.tokensByHash.set(token.toProps().tokenHash, token);
  }

  async findTokenByHash(tokenHash: string): Promise<ApiToken | null> {
    return this.tokensByHash.get(tokenHash) ?? null;
  }
}
