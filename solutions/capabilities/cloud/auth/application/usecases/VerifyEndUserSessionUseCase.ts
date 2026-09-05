// Who an "es_..." session token authenticates as, or null. Checked on
// every authenticated end-user request — the end-user equivalent of
// @carbon/identity's VerifyTokenUseCase, kept as a separate use case
// (and a separate token namespace) because an end-user session and a
// developer/org API token are not interchangeable credentials.

import { hashToken } from "../../domain/value-objects/TokenHash.ts";
import type { AuthRepository } from "../ports/AuthRepository.ts";

export interface VerifiedSession {
  readonly endUserId: string;
  readonly orgId: string;
}

export class VerifyEndUserSessionUseCase {
  constructor(private readonly auth: AuthRepository) {}

  async execute(plaintext: string): Promise<VerifiedSession | null> {
    const session = await this.auth.findSessionByHash(hashToken(plaintext));
    if (!session || !session.isValid()) return null;
    return { endUserId: session.endUserId, orgId: session.orgId };
  }
}
