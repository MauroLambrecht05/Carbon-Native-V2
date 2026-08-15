import type { Organization } from "../../domain/entities/Organization.ts";
import type { ApiToken } from "../../domain/entities/ApiToken.ts";

export interface IdentityRepository {
  saveOrganization(org: Organization): Promise<void>;
  saveToken(token: ApiToken): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<ApiToken | null>;
}
