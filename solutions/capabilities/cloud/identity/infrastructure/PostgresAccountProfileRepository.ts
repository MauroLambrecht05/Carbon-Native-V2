import { randomUUID } from "node:crypto";
import { parseComponent, PlatformFault } from "@carbon/contracts/platform";
import type { AccountProfileRepository, EmailChangeCompletion, ProfileMutation } from "../application/ports/AccountProfileRepository.ts";
import type { FreshAuthBinding } from "../domain/entities/AccountIdentity.ts";
import type { PostgresMfaVerification, StoredMfaFactor } from "./PostgresMfaVerification.ts";

export class PostgresAccountProfileRepository implements AccountProfileRepository {
  constructor(private readonly sql: Bun.SQL, private readonly mfa: PostgresMfaVerification) {}

  async pendingEmail(binding: FreshAuthBinding, expectedRevision: string) {
    return this.sql.begin(async tx => {
      const actor = await this.actor(tx, binding);
      if (actor.account_revision !== expectedRevision) throw new PlatformFault("conflict", "Account changed; refresh the profile");
      const rows = await tx`SELECT c.proposed_email, c.expires_at FROM account_email_changes c JOIN account_sessions s ON s.id = c.session_id
        WHERE c.account_id = ${actor.id} AND c.state = 'pending' AND c.expires_at > now() AND c.security_revision = ${actor.security_revision}
          AND s.revoked_at IS NULL AND s.expires_at > now()`;
      return rows.length ? { email: rows[0].proposed_email as string, expiresAt: rows[0].expires_at.toISOString() as string } : null;
    });
  }

  private async actor(tx: Bun.TransactionSQL, binding: FreshAuthBinding) {
    await tx`SELECT id FROM accounts WHERE id = ${binding.accountId} FOR UPDATE`;
    const rows = await tx`SELECT a.*, a.revision::text AS account_revision, s.expires_at, s.fresh_until > now() AS fresh, s.device_name
      FROM accounts a JOIN account_sessions s ON s.account_id = a.id
      WHERE a.id = ${binding.accountId} AND s.id = ${binding.sessionId} AND a.state = 'active'
        AND s.token_hash = ${binding.tokenHash} AND s.csrf_hash = ${binding.csrfHash}
        AND s.revoked_at IS NULL AND s.expires_at > now() AND s.security_revision = a.security_revision
        AND a.security_revision = ${binding.securityRevision}
        AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))`;
    if (!rows.length) throw new PlatformFault("unauthenticated", "This session is no longer valid");
    return rows[0];
  }

  private async cancelPending(tx: Bun.TransactionSQL, accountId: string, state: "cancelled" | "superseded") {
    const cancelled = await tx`UPDATE account_email_changes SET state = ${state} WHERE account_id = ${accountId} AND state = 'pending' RETURNING id`;
    for (const row of cancelled) await tx`UPDATE account_email_outbox SET state = 'expired', protected_message = NULL, lease_id = NULL, lease_expires_at = NULL
      WHERE email_change_id = ${row.id} AND state IN ('pending', 'sending')`;
  }

  async execute(mutation: ProfileMutation) {
    return this.sql.begin(async tx => {
      const actor = await this.actor(tx, mutation.binding);
      const previous = await tx`SELECT request_digest, result FROM account_security_commands
        WHERE account_id = ${actor.id} AND session_id = ${mutation.binding.sessionId} AND key_digest = ${mutation.keyDigest}`;
      if (previous.length) {
        if (previous[0].request_digest !== mutation.requestDigest) throw new PlatformFault("conflict", "The idempotency key was used for another command");
        return parseComponent("AccountSecurityReceipt", previous[0].result);
      }
      if (actor.account_revision !== mutation.expectedRevision) throw new PlatformFault("conflict", "Account changed; refresh before retrying");
      const command = mutation.command;
      if (command.kind !== "update" && !actor.fresh) throw new PlatformFault("forbidden", "Recent authentication is required", { authentication: "fresh_required" });
      if (command.kind === "update") await tx`UPDATE accounts SET name = ${command.name}, avatar = ${command.avatar} WHERE id = ${actor.id}`;
      else {
        await this.cancelPending(tx, actor.id, command.kind === "email-cancel" ? "cancelled" : "superseded");
        if (command.kind === "email-change") {
          const change = mutation.emailChange;
          if (!change) throw new Error("Missing email verification payload");
          if (command.email === actor.primary_email) throw new PlatformFault("validation", "Choose a different email address");
          for (const key of [...new Set(change.rateKeys)].sort()) {
            const rows = await tx`INSERT INTO account_auth_rate_limits (key_hash, window_start, requests) VALUES (${key}, now(), 1)
              ON CONFLICT (key_hash) DO UPDATE SET
                requests = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '15 minutes' THEN 1 ELSE account_auth_rate_limits.requests + 1 END,
                window_start = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '15 minutes' THEN now() ELSE account_auth_rate_limits.window_start END
              RETURNING requests`;
            if (rows[0].requests > 20) throw new PlatformFault("rate_limited", "Too many verification requests; try again later");
          }
          await tx`INSERT INTO account_email_changes (id, account_id, session_id, security_revision, previous_email, proposed_email, browser_hash, token_hash, state, expires_at)
            VALUES (${change.id}, ${actor.id}, ${mutation.binding.sessionId}, ${actor.security_revision}, ${actor.primary_email}, ${command.email}, ${change.browserHash}, ${change.tokenHash}, 'pending', ${change.expiresAt})`;
          await tx`INSERT INTO account_email_outbox (id, email_change_id, protected_message, expires_at)
            VALUES (${change.id}, ${change.id}, ${change.protectedMessage}, ${change.expiresAt})`;
        }
      }
      const rows = await tx`UPDATE accounts SET revision = revision + 1, updated_at = now() WHERE id = ${actor.id} RETURNING revision::text`;
      const receipt = parseComponent("AccountSecurityReceipt", { message: command.kind === "email-change" ? "If this address can be used, a verification email will arrive shortly." : "Account updated", revision: rows[0].revision });
      await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision)
        VALUES (${randomUUID()}, ${actor.id}, ${mutation.binding.sessionId}, ${`account.profile.${command.kind}`}, ${mutation.requestId}, ${actor.security_revision})`;
      await tx`INSERT INTO account_security_commands (account_id, session_id, key_digest, request_digest, result)
        VALUES (${actor.id}, ${mutation.binding.sessionId}, ${mutation.keyDigest}, ${mutation.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb)`;
      return receipt;
    });
  }

  async completeEmail(input: EmailChangeCompletion) {
    const result = await this.sql.begin(async tx => {
      const candidates = await tx`SELECT * FROM account_email_changes WHERE token_hash = ${input.tokenHash} AND browser_hash = ${input.browserHash}
        AND account_id = ${input.binding.accountId} AND session_id = ${input.binding.sessionId} AND state = 'pending' AND expires_at > now()`;
      const change = candidates[0];
      if (!change) throw new PlatformFault("unauthenticated", "The verification link is invalid or expired");
      // Use the same namespace as login/registration and acquire every email
      // lock before the account lock, preventing identity-claim races.
      for (const email of [...new Set<string>([change.previous_email, change.proposed_email])].sort()) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${email}, 1128354370))`;
      const actor = await this.actor(tx, input.binding);
      if (actor.primary_email !== change.previous_email || actor.primary_email !== input.previousEmail
        || String(change.security_revision) !== String(actor.security_revision)) throw new PlatformFault("unauthenticated", "The authentication context changed");
      const current = await tx`SELECT id FROM account_email_changes WHERE id = ${change.id} AND state = 'pending' AND expires_at > now() FOR UPDATE`;
      if (!current.length) throw new PlatformFault("unauthenticated", "The verification link is invalid or expired");
      const claimed = await tx`SELECT id FROM accounts WHERE primary_email = ${change.proposed_email}
        UNION ALL SELECT account_id AS id FROM account_identities WHERE provider = 'email' AND provider_subject = ${change.proposed_email}`;
      if (claimed.length) throw new PlatformFault("conflict", "This verified address is already linked to an account");
      const factors = await tx<StoredMfaFactor[]>`SELECT id, encrypted_secret_reference, last_counter FROM mfa_factors WHERE account_id = ${actor.id} AND state = 'active'`;
      if (factors.length) {
        if (!input.code) throw new PlatformFault("unauthenticated", "MFA verification is required", { code: "mfa_required" });
        const verification = await this.mfa.verify(tx, actor.id, factors[0]!, input.code, true);
        if (verification !== "verified") return { fault: verification } as const;
      }
      const identity = await tx`UPDATE account_identities SET provider_subject = ${change.proposed_email}, verified_at = now()
        WHERE account_id = ${actor.id} AND provider = 'email' AND provider_subject = ${actor.primary_email} RETURNING id`;
      if (identity.length !== 1) throw new PlatformFault("conflict", "The sign-in identity changed; restart verification");
      const updated = await tx`UPDATE accounts SET primary_email = ${change.proposed_email}, verified_at = now(), revision = revision + 1,
        security_revision = security_revision + 1, updated_at = now() WHERE id = ${actor.id} RETURNING security_revision`;
      await tx`UPDATE account_sessions SET revoked_at = now() WHERE account_id = ${actor.id} AND revoked_at IS NULL`;
      await tx`UPDATE account_challenges SET consumed_at = now() WHERE email IN (${change.previous_email}, ${change.proposed_email}) AND consumed_at IS NULL`;
      await tx`UPDATE account_email_changes SET state = 'verified', completed_at = now() WHERE id = ${change.id}`;
      const freshUntil = new Date(Math.min(input.issue.freshUntil.getTime(), actor.expires_at.getTime()));
      await tx`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until, mfa_verified_at)
        VALUES (${input.issue.id}, ${actor.id}, ${input.issue.tokenHash}, ${input.issue.csrfHash}, ${updated[0].security_revision}, ${actor.device_name}, ${actor.expires_at}, ${freshUntil}, ${factors.length ? new Date() : null})`;
      await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision)
        VALUES (${randomUUID()}, ${actor.id}, ${input.issue.id}, 'account.email.changed', ${input.issue.requestId}, ${updated[0].security_revision})`;
      await tx`INSERT INTO account_email_outbox (id, account_id, protected_message, expires_at)
        VALUES (${input.notice.id}, ${actor.id}, ${input.notice.protectedMessage}, now() + interval '24 hours')`;
      return { expiresAt: actor.expires_at.toISOString() as string };
    });
    if ("fault" in result) throw new PlatformFault(result.fault === "locked" ? "rate_limited" : "unauthenticated", "MFA code is invalid, already used, or temporarily locked", { code: "invalid" });
    return result;
  }
}
