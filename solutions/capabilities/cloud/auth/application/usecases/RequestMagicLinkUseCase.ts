// Step 1 of magic-link sign-in: given an org and an email, find-or-create
// the EndUser and mint a single-use token. Returns the plaintext once —
// same "shown once, only the hash is kept" posture as
// CreateOrganizationUseCase's api token.
//
// DOES NOT SEND EMAIL. No transport exists yet (that's carbon-email,
// roadmap phase 5) — the caller (carbon-cloud's route) is responsible for
// making that limitation visible rather than pretending a real delivery
// step happened. See that route's own comment.

import { EndUser } from "../../domain/entities/EndUser.ts";
import { MagicLinkToken } from "../../domain/entities/MagicLinkToken.ts";
import type { AuthRepository } from "../ports/AuthRepository.ts";

export interface RequestMagicLinkResult {
  readonly endUserId: string;
  /** Shown once. Not recoverable — only its hash is stored. */
  readonly plaintextToken: string;
  readonly expiresAt: Date;
}

export class RequestMagicLinkUseCase {
  constructor(private readonly auth: AuthRepository) {}

  async execute(orgId: string, email: string): Promise<RequestMagicLinkResult> {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail.includes("@")) {
      throw new Error("a valid email address is required");
    }

    let user = await this.auth.findEndUserByEmail(orgId, normalizedEmail);
    if (!user) {
      user = EndUser.create({ id: crypto.randomUUID(), orgId, email: normalizedEmail });
      await this.auth.saveEndUser(user);
    }

    // "ml_" — a magic-link token, distinct at a glance from "cc_"
    // (org)/"wk_" (worker) API tokens and the "es_" session token this
    // exchanges for, the same Stripe-style prefix convention
    // CreateOrganizationUseCase already uses.
    const plaintext = `ml_${crypto.randomUUID().replaceAll("-", "")}`;
    const token = MagicLinkToken.issue({ id: crypto.randomUUID(), endUserId: user.id, plaintext });
    await this.auth.saveMagicLinkToken(token);

    return { endUserId: user.id, plaintextToken: plaintext, expiresAt: token.toProps().expiresAt };
  }
}
