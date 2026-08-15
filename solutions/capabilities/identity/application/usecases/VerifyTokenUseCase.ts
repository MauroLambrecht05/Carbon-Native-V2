import { hashToken } from "../../domain/value-objects/TokenHash.ts";
import type { IdentityRepository } from "../ports/IdentityRepository.ts";

export class VerifyTokenUseCase {
  constructor(private readonly identity: IdentityRepository) {}

  /** The org a plaintext token authenticates as, or null if it's not valid. */
  async execute(plaintext: string): Promise<string | null> {
    const token = await this.identity.findTokenByHash(hashToken(plaintext));
    return token?.orgId ?? null;
  }
}
