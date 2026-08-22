import { hashToken } from "../../domain/value-objects/TokenHash.ts";
import type { TokenScope } from "../../domain/entities/ApiToken.ts";
import type { IdentityRepository } from "../ports/IdentityRepository.ts";

export interface VerifiedToken {
  readonly orgId: string;
  readonly scope: TokenScope;
}

export class VerifyTokenUseCase {
  constructor(private readonly identity: IdentityRepository) {}

  /** Who a plaintext token authenticates as, or null if it's not valid. */
  async execute(plaintext: string): Promise<VerifiedToken | null> {
    const token = await this.identity.findTokenByHash(hashToken(plaintext));
    if (!token) return null;
    const props = token.toProps();
    return { orgId: props.orgId, scope: props.scope };
  }
}
