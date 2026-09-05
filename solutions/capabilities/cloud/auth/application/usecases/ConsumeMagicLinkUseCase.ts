// Step 2 of magic-link sign-in: exchange a still-usable magic-link token
// for a session. Single-use — a second exchange attempt with the same
// plaintext fails even seconds later, whether or not it's expired yet.

import { hashToken } from "../../domain/value-objects/TokenHash.ts";
import { Session } from "../../domain/entities/Session.ts";
import type { AuthRepository } from "../ports/AuthRepository.ts";

export interface ConsumeMagicLinkResult {
  readonly endUserId: string;
  readonly orgId: string;
  /** Shown once. Not recoverable — only its hash is stored. */
  readonly sessionToken: string;
  readonly expiresAt: Date;
}

export class ConsumeMagicLinkUseCase {
  constructor(private readonly auth: AuthRepository) {}

  /**
   * `orgId` is NOT a parameter here on purpose — it is derived from the
   * token's own end user record, never trusted from the caller. Accepting
   * it as an argument would let whoever holds a valid magic link for
   * their own account claim a session scoped to a DIFFERENT org just by
   * naming one in the request — the exact cross-tenant elevation the
   * org/worker token split elsewhere in this product exists to prevent.
   */
  async execute(plaintextMagicLink: string): Promise<ConsumeMagicLinkResult> {
    const token = await this.auth.findMagicLinkTokenByHash(hashToken(plaintextMagicLink));
    if (!token || !token.isUsable()) {
      throw new Error("this sign-in link is invalid, already used, or has expired");
    }

    const user = await this.auth.findEndUserById(token.endUserId);
    if (!user) {
      // The end user row this token points at is gone — a deleted
      // account, not a malformed token. Same external error either way:
      // nothing about "which half failed" is useful to hand back.
      throw new Error("this sign-in link is invalid, already used, or has expired");
    }

    const now = new Date();
    await this.auth.markMagicLinkTokenConsumed(token.id, now);

    // "es_" — an end-user session token, distinct at a glance from the
    // "ml_" magic link it was exchanged for and from "cc_"/"wk_" org/
    // worker API tokens.
    const plaintext = `es_${crypto.randomUUID().replaceAll("-", "")}`;
    const session = Session.issue({ id: crypto.randomUUID(), endUserId: user.id, orgId: user.orgId, plaintext, now });
    await this.auth.saveSession(session);

    return {
      endUserId: user.id,
      orgId: user.orgId,
      sessionToken: plaintext,
      expiresAt: session.toProps().expiresAt,
    };
  }
}
