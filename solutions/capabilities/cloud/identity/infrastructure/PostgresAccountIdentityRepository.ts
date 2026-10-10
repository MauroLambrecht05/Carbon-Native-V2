import { randomUUID } from "node:crypto";
import { PlatformFault } from "@carbon/contracts/platform";
import type { AccountIdentityRepository } from "../application/ports/AccountIdentityRepository.ts";
import type { AccountChallenge, BrowserSession, FreshAuthBinding, SessionIssue } from "../domain/entities/AccountIdentity.ts";
import type { PostgresMfaVerification, StoredMfaFactor } from "./PostgresMfaVerification.ts";

interface SessionRow {
  id: string; account_id: string; primary_email: string; name: string; verified_at: Date;
  terms_version: string; security_revision: string; permission_revision: string; revision: string; avatar: string; mfa: boolean; created_at: Date;
  expires_at: Date; fresh_until: Date; device_name: string; csrf_hash: string;
}
function sessionFromRow(row: SessionRow): BrowserSession {
  return {
    id: row.id, account: { id: row.account_id, email: row.primary_email, name: row.name, avatar: row.avatar, verifiedAt: row.verified_at.toISOString(), termsVersion: row.terms_version, securityRevision: row.security_revision, permissionRevision: String(row.permission_revision), revision: String(row.revision), mfa: row.mfa },
    createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), freshUntil: row.fresh_until.toISOString(), deviceName: row.device_name, csrfHash: row.csrf_hash,
  };
}

export class PostgresAccountIdentityRepository implements AccountIdentityRepository {
  constructor(private readonly sql: Bun.SQL, private readonly mfa?: PostgresMfaVerification) {}

  async queueChallenge(challenge: AccountChallenge): Promise<void> {
    await this.sql.begin(async tx => {
      const binding = challenge.freshAuth;
      if ((challenge.purpose === "fresh_auth") !== Boolean(binding)) throw new PlatformFault("unauthenticated", "Invalid authentication context");
      if (binding) {
        await tx`SELECT id FROM accounts WHERE id = ${binding.accountId} FOR UPDATE`;
        const actors = await tx`SELECT s.id FROM account_sessions s JOIN accounts a ON a.id = s.account_id
          WHERE s.id = ${binding.sessionId} AND s.account_id = ${binding.accountId}
            AND s.token_hash = ${binding.tokenHash} AND s.csrf_hash = ${binding.csrfHash}
            AND s.revoked_at IS NULL AND s.expires_at > now() AND a.state = 'active' AND a.primary_email = ${challenge.email}
            AND s.security_revision = a.security_revision AND a.security_revision = ${binding.securityRevision}
            AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))`;
        if (!actors.length) throw new PlatformFault("unauthenticated", "This session is no longer valid");
      }
      const inserted = await tx`
        INSERT INTO account_challenges
          (id, email, name, purpose, token_hash, browser_hash, terms_version, redirect_path, expires_at, request_key, request_digest, request_id, bound_session_id, bound_security_revision)
        VALUES (${challenge.id}, ${challenge.email}, ${challenge.name}, ${challenge.purpose}, ${challenge.tokenHash}, ${challenge.browserHash}, ${challenge.termsVersion}, ${challenge.redirectPath}, ${challenge.expiresAt}, ${challenge.requestKey}, ${challenge.requestDigest}, ${challenge.requestId}, ${binding?.sessionId ?? null}, ${binding?.securityRevision ?? null})
        ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING RETURNING id
      `;
      if (!inserted.length) {
        const existing = await tx`SELECT request_digest FROM account_challenges WHERE request_key = ${challenge.requestKey}`;
        if (existing[0]?.request_digest !== challenge.requestDigest) throw new PlatformFault("conflict", "The idempotency key was already used for a different request");
        return;
      }
      // Stable order prevents two overlapping email/IP key sets from deadlocking.
      for (const key of [...challenge.rateKeys].sort()) {
        const rows = await tx`
          INSERT INTO account_auth_rate_limits (key_hash, window_start, requests) VALUES (${key}, now(), 1)
          ON CONFLICT (key_hash) DO UPDATE SET
            requests = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '15 minutes' THEN 1 ELSE account_auth_rate_limits.requests + 1 END,
            window_start = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '15 minutes' THEN now() ELSE account_auth_rate_limits.window_start END
          RETURNING requests
        `;
        if (rows[0].requests > 20) throw new PlatformFault("rate_limited", "Too many sign-in requests; try again later");
      }
      await tx`INSERT INTO account_email_outbox (id, protected_message, expires_at) VALUES (${challenge.id}, ${challenge.protectedMessage}, ${challenge.expiresAt})`;
      if (binding) await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision)
        VALUES (${randomUUID()}, ${binding.accountId}, ${binding.sessionId}, 'session.fresh_auth_requested', ${challenge.requestId}, ${binding.securityRevision})`;
    });
  }

  async consumeChallenge(tokenHash: string, browserHash: string, issue: SessionIssue, code?: string, freshAuth?: FreshAuthBinding): Promise<{ session: BrowserSession; redirectPath: string }> {
    const result = await this.sql.begin(async tx => {
      const challenges = await tx`
        SELECT * FROM account_challenges WHERE token_hash = ${tokenHash} AND browser_hash = ${browserHash}
          AND consumed_at IS NULL AND expires_at > now()
      `;
      const challenge = challenges[0];
      if (!challenge) throw new PlatformFault("unauthenticated", "The sign-in link is invalid or expired");
      if ((challenge.purpose === "fresh_auth") !== Boolean(freshAuth)) throw new PlatformFault("unauthenticated", "The proof cannot be used for this authentication flow");
      // Serialize independent challenges for one email before creating/locking its account.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${challenge.email}, 1128354370))`;
      let accounts = await tx`SELECT * FROM accounts WHERE primary_email = ${challenge.email} FOR UPDATE`;
      if (!accounts.length && challenge.purpose === "registration") {
        const accountId = randomUUID();
        accounts = await tx`
          INSERT INTO accounts (id, primary_email, name, verified_at, terms_version)
          VALUES (${accountId}, ${challenge.email}, ${challenge.name}, now(), ${challenge.terms_version}) RETURNING *
        `;
        await tx`INSERT INTO account_identities (id, account_id, provider, provider_subject, verified_at)
          VALUES (${randomUUID()}, ${accountId}, 'email', ${challenge.email}, now())`;
        await tx`INSERT INTO account_security_events (id, account_id, action, request_id, security_revision)
          VALUES (${randomUUID()}, ${accountId}, 'account.registered', ${issue.requestId}, 1)`;
      }
      let account = accounts[0];
      if (!account || account.state !== "active") throw new PlatformFault("unauthenticated", "The sign-in link is invalid or expired");
      // Lock account before challenge, matching fresh-auth request and security
      // mutation order. Recheck single-use state after the serialization point.
      const available = await tx`SELECT id FROM account_challenges WHERE id = ${challenge.id}
        AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`;
      if (!available.length) throw new PlatformFault("unauthenticated", "The sign-in link is invalid or expired");
      let expiresAt = issue.expiresAt; let freshUntil = issue.freshUntil; let deviceName = issue.deviceName;
      if (freshAuth) {
        if (freshAuth.accountId !== account.id || challenge.bound_session_id !== freshAuth.sessionId
          || String(challenge.bound_security_revision) !== String(account.security_revision)
          || freshAuth.securityRevision !== String(account.security_revision)) throw new PlatformFault("unauthenticated", "The authentication context changed");
        const actors = await tx`SELECT id, expires_at, device_name FROM account_sessions
          WHERE id = ${freshAuth.sessionId} AND account_id = ${account.id}
            AND token_hash = ${freshAuth.tokenHash} AND csrf_hash = ${freshAuth.csrfHash}
            AND revoked_at IS NULL AND expires_at > now() AND security_revision = ${account.security_revision}
            AND (mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = ${account.id} AND f.state = 'active'))
          FOR UPDATE`;
        if (!actors.length) throw new PlatformFault("unauthenticated", "This session is no longer valid");
        expiresAt = actors[0].expires_at;
        freshUntil = new Date(Math.min(issue.freshUntil.getTime(), expiresAt.getTime()));
        deviceName = actors[0].device_name;
      }
      const factors = await tx<StoredMfaFactor[]>`SELECT id, encrypted_secret_reference, last_counter FROM mfa_factors WHERE account_id = ${account.id} AND state = 'active'`;
      if (factors.length) {
        if (!this.mfa) throw new PlatformFault("capability", "MFA verification is not configured");
        if (!code) throw new PlatformFault("unauthenticated", "MFA verification is required", { code: "mfa_required" });
        const verification = await this.mfa.verify(tx, account.id, factors[0]!, code, true);
        if (verification !== "verified") return { fault: verification } as const;
      }
      if (challenge.purpose === "recovery") {
        const recovered = await tx`UPDATE accounts SET security_revision = security_revision + 1, updated_at = now() WHERE id = ${account.id} RETURNING *`;
        account = recovered[0];
        await tx`UPDATE account_sessions SET revoked_at = now() WHERE account_id = ${account.id} AND revoked_at IS NULL`;
        await tx`INSERT INTO account_security_events (id, account_id, action, request_id, security_revision)
          VALUES (${randomUUID()}, ${account.id}, 'account.recovered', ${issue.requestId}, ${account.security_revision})`;
      }
      if (freshAuth) {
        await tx`UPDATE account_sessions SET revoked_at = now() WHERE id = ${freshAuth.sessionId}`;
        await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision)
          VALUES (${randomUUID()}, ${account.id}, ${freshAuth.sessionId}, 'session.refreshed', ${issue.requestId}, ${account.security_revision})`;
      }
      const revised = await tx`UPDATE accounts SET revision = revision + 1 WHERE id = ${account.id} RETURNING revision`;
      account.revision = revised[0].revision;
      const sessions = await tx`
        INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until, mfa_verified_at)
        VALUES (${issue.id}, ${account.id}, ${issue.tokenHash}, ${issue.csrfHash}, ${account.security_revision}, ${deviceName}, ${expiresAt}, ${freshUntil}, ${factors.length ? new Date() : null}) RETURNING *
      `;
      await tx`UPDATE account_challenges SET consumed_at = now() WHERE id = ${challenge.id}`;
      await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision)
        VALUES (${randomUUID()}, ${account.id}, ${issue.id}, 'session.issued', ${issue.requestId}, ${account.security_revision})`;
      const row = { ...account, ...sessions[0], security_revision: String(account.security_revision), mfa: factors.length > 0 } as SessionRow;
      return { session: sessionFromRow(row), redirectPath: challenge.redirect_path as string };
    });
    if ("fault" in result) throw new PlatformFault(result.fault === "locked" ? "rate_limited" : "unauthenticated", "MFA code is invalid, already used, or temporarily locked", { code: "invalid" });
    return result;
  }

  async findSession(tokenHash: string): Promise<BrowserSession | null> {
    const rows = await this.sql<SessionRow[]>`
      SELECT s.id, s.account_id, s.created_at, s.expires_at, s.fresh_until, s.device_name, s.csrf_hash,
        a.primary_email, a.name, a.avatar, a.verified_at, a.terms_version, a.security_revision::text, a.permission_revision::text, a.revision::text,
        EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active') AS mfa
      FROM account_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ${tokenHash} AND s.revoked_at IS NULL AND s.expires_at > now()
        AND a.state = 'active' AND s.security_revision = a.security_revision
        AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))
    `;
    return rows[0] ? sessionFromRow(rows[0]) : null;
  }

  async revokeSession(tokenHash: string, csrfHash: string, requestId: string): Promise<void> {
    await this.sql.begin(async tx => {
      await tx`SELECT id FROM accounts WHERE id = (SELECT account_id FROM account_sessions WHERE token_hash = ${tokenHash}) FOR UPDATE`;
      const sessions = await tx`
        UPDATE account_sessions SET revoked_at = now()
        WHERE token_hash = ${tokenHash} AND csrf_hash = ${csrfHash} AND revoked_at IS NULL
        RETURNING id, account_id, security_revision
      `;
      if (!sessions.length) return;
      const session = sessions[0];
      await tx`UPDATE accounts SET revision = revision + 1, updated_at = now() WHERE id = ${session.account_id}`;
      await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision)
        VALUES (${randomUUID()}, ${session.account_id}, ${session.id}, 'session.revoked', ${requestId}, ${session.security_revision})`;
    });
  }
}
