import { randomUUID } from "node:crypto";
import { PlatformFault, parseComponent } from "@carbon/contracts/platform";
import type { AccountSecurityMutation, AccountSecurityRepository, AccountSecurityResult } from "../application/ports/AccountSecurityRepository.ts";
import type { PostgresMfaVerification, StoredMfaFactor } from "./PostgresMfaVerification.ts";

export class PostgresAccountSecurityRepository implements AccountSecurityRepository {
  constructor(private readonly sql: Bun.SQL, private readonly mfa: PostgresMfaVerification) {}

  async listIdentities(tokenHash: string, expectedRevision: string) {
    return this.sql.begin(async tx => {
      await tx`SELECT id FROM accounts WHERE id = (SELECT account_id FROM account_sessions WHERE token_hash = ${tokenHash}) FOR SHARE`;
      const actors = await tx`SELECT a.id, a.primary_email, a.revision::text FROM accounts a JOIN account_sessions s ON s.account_id = a.id
        WHERE s.token_hash = ${tokenHash} AND a.state = 'active' AND s.revoked_at IS NULL AND s.expires_at > now() AND s.security_revision = a.security_revision
          AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))`;
      const actor = actors[0]; if (!actor) throw new PlatformFault("unauthenticated", "This session is no longer valid");
      if (actor.revision !== expectedRevision) throw new PlatformFault("conflict", "Account security changed; reload identities");
      const rows = await tx<{ id: string; provider: 'email' | 'github'; provider_subject: string; verified_at: Date }[]>`SELECT id, provider, provider_subject, verified_at FROM account_identities WHERE account_id = ${actor.id} ORDER BY provider, id LIMIT 100`;
      const emailAvailable = rows.some(row => row.provider === 'email' && row.provider_subject === actor.primary_email);
      return rows.map(row => parseComponent("AccountIdentitySummary", { id: row.id, provider: row.provider, subject: row.provider_subject, verifiedAt: row.verified_at.toISOString(), canUnlink: row.provider === 'github' && emailAvailable }));
    });
  }

  async listSessions(tokenHash: string, expectedRevision: string, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      // All account/session mutations acquire the account lock first. Holding a
      // shared lock keeps authorization and this page at the same revision.
      await tx`SELECT id FROM accounts WHERE id = (SELECT account_id FROM account_sessions WHERE token_hash = ${tokenHash}) FOR SHARE`;
      const actors = await tx`SELECT s.id, a.id AS account_id, a.revision::text, a.security_revision
        FROM accounts a JOIN account_sessions s ON s.account_id = a.id
        WHERE s.token_hash = ${tokenHash} AND a.state = 'active' AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.security_revision = a.security_revision
          AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))`;
      const actor = actors[0];
      if (!actor) throw new PlatformFault("unauthenticated", "This session is no longer valid");
      if (actor.revision !== expectedRevision) throw new PlatformFault("conflict", "Account security changed; restart the list");
      const rows = await tx<{ id: string; created_at: Date; expires_at: Date; device_name: string; mfa_verified: boolean }[]>`SELECT id, created_at, expires_at, device_name, mfa_verified_at IS NOT NULL AS mfa_verified
        FROM account_sessions WHERE account_id = ${actor.account_id} AND revoked_at IS NULL AND expires_at > now()
          AND security_revision = ${actor.security_revision} AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid)
          AND (mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = ${actor.account_id} AND f.state = 'active'))
        ORDER BY id LIMIT ${limit}`;
      return rows.map(row => parseComponent("AccountSessionSummary", { id: row.id, createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(), deviceName: row.device_name, current: row.id === actor.id, mfaVerified: row.mfa_verified }));
    });
  }

  async execute(mutation: AccountSecurityMutation): Promise<AccountSecurityResult> {
    const result = await this.sql.begin(async tx => {
      await tx`SELECT id FROM accounts WHERE id = (SELECT account_id FROM account_sessions WHERE token_hash = ${mutation.tokenHash}) FOR UPDATE`;
      const sessions = await tx`
        SELECT a.id AS account_id, a.revision::text, a.security_revision, s.id AS session_id,
          s.expires_at, s.fresh_until, s.mfa_verified_at, s.fresh_until > now() AS fresh
        FROM accounts a JOIN account_sessions s ON s.account_id = a.id
        WHERE s.token_hash = ${mutation.tokenHash} AND s.csrf_hash = ${mutation.csrfHash}
          AND a.state = 'active' AND s.revoked_at IS NULL AND s.expires_at > now() AND a.security_revision = s.security_revision
          AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))
        FOR UPDATE OF s
      `;
      const actor = sessions[0];
      if (!actor) throw new PlatformFault("unauthenticated", "This session is no longer valid");
      const previous = await tx`SELECT request_digest, result FROM account_security_commands
        WHERE account_id = ${actor.account_id} AND session_id = ${actor.session_id} AND key_digest = ${mutation.keyDigest}`;
      if (previous.length) {
        if (previous[0].request_digest !== mutation.requestDigest) throw new PlatformFault("conflict", "The idempotency key was used for another command");
        return { receipt: parseComponent("AccountSecurityReceipt", previous[0].result), disclose: false, rotated: false };
      }
      if (actor.revision !== mutation.expectedRevision) throw new PlatformFault("conflict", "Account security changed; refresh before retrying");
      const command = mutation.command;
      if (command.kind !== "session-rotate" && !actor.fresh) throw new PlatformFault("forbidden", "Recent authentication is required", { authentication: "fresh_required" });
      const factors = await tx<(StoredMfaFactor & { state: string; unexpired: boolean })[]>`
        SELECT id, encrypted_secret_reference, last_counter, state, expires_at > now() AS unexpired
        FROM mfa_factors WHERE account_id = ${actor.account_id} AND state IN ('active', 'pending') FOR UPDATE
      `;
      const active = factors.find(f => f.state === "active");
      let rotated = false; let securityChanged = false; let disclose = false; let factorId: string | undefined;
      if (command.kind === "mfa-start") {
        if (active) throw new PlatformFault("conflict", "MFA is already enabled");
        if (!mutation.enrollment) throw new Error("Missing MFA enrollment payload");
        await tx`UPDATE mfa_factors SET state = 'disabled', encrypted_secret_reference = '' WHERE account_id = ${actor.account_id} AND state = 'pending'`;
        await tx`INSERT INTO mfa_factors (id, account_id, kind, encrypted_secret_reference, state, expires_at)
          VALUES (${mutation.enrollment.id}, ${actor.account_id}, 'totp', ${mutation.enrollment.protectedSecret}, 'pending', now() + interval '10 minutes')`;
        factorId = mutation.enrollment.id; disclose = true;
      } else if (command.kind === "mfa-confirm" || command.kind === "mfa-disable" || command.kind === "recovery-reset") {
        const factor = command.kind === "mfa-confirm" ? factors.find(f => f.id === command.factorId && f.state === "pending" && f.unexpired) : active;
        if (!factor) throw new PlatformFault("not_found", "MFA factor is not available");
        if (command.kind === "mfa-disable") {
          const required = await tx`SELECT 1 FROM memberships m JOIN organizations o ON o.id = m.org_id
            WHERE m.account_id = ${actor.account_id} AND m.state = 'active' AND o.owner_policy->>'requireMfa' = 'true' LIMIT 1`;
          if (required.length) throw new PlatformFault("forbidden", "An organization requires MFA for this account");
        }
        const verification = await this.mfa.verify(tx, actor.account_id, factor, command.code, command.kind !== "mfa-confirm");
        if (verification !== "verified") return { fault: verification } as const;
        if (command.kind === "mfa-confirm") await tx`UPDATE mfa_factors SET state = 'active', verified_at = now(), expires_at = NULL WHERE id = ${factor.id}`;
        if (command.kind === "mfa-disable") await tx`UPDATE mfa_factors SET state = 'disabled', encrypted_secret_reference = '' WHERE id = ${factor.id}`;
        await tx`UPDATE recovery_codes SET consumed_at = now() WHERE account_id = ${actor.account_id} AND consumed_at IS NULL`;
        if (command.kind !== "mfa-disable") {
          if (mutation.recoveryHashes.length !== 10) throw new Error("MFA recovery set must contain ten codes");
          for (const digest of mutation.recoveryHashes) await tx`INSERT INTO recovery_codes (id, account_id, code_hash) VALUES (${randomUUID()}, ${actor.account_id}, ${digest})`;
          disclose = true;
        }
        securityChanged = true; rotated = true; factorId = factor.id;
      } else if (command.kind === "identity-unlink") {
        const identities = await tx`SELECT id, provider, provider_subject FROM account_identities WHERE account_id = ${actor.account_id} FOR UPDATE`;
        const identity = identities.find((row: { id: string }) => row.id === command.identityId);
        if (!identity) throw new PlatformFault("not_found", "Identity not found");
        if (identity.provider !== 'github') throw new PlatformFault("validation", "Change your verified email through the profile verification flow");
        const fallback = await tx`SELECT i.id FROM account_identities i JOIN accounts a ON a.id = i.account_id WHERE a.id = ${actor.account_id}
          AND i.id <> ${identity.id} AND i.provider = 'email' AND i.provider_subject = a.primary_email AND i.verified_at IS NOT NULL`;
        if (!fallback.length) throw new PlatformFault("conflict", "Keep a verified sign-in method before unlinking GitHub");
        if (active) {
          if (!command.code) throw new PlatformFault("unauthenticated", "MFA verification is required", { code: "mfa_required" });
          const verified = await this.mfa.verify(tx, actor.account_id, active, command.code, true);
          if (verified !== 'verified') return { fault: verified } as const;
        }
        await tx`DELETE FROM account_identities WHERE id = ${identity.id}`;
        securityChanged = true; rotated = true;
      } else if (command.kind === "session-rotate") rotated = true;
      else if (command.kind === "sessions-revoke-others") {
        await tx`UPDATE account_sessions SET revoked_at = now() WHERE account_id = ${actor.account_id} AND id <> ${actor.session_id} AND revoked_at IS NULL`;
      } else if (command.kind === "session-revoke") {
        if (command.sessionId === actor.session_id) throw new PlatformFault("validation", "Use sign-out to revoke the current session");
        const changed = await tx`UPDATE account_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE account_id = ${actor.account_id} AND id = ${command.sessionId} RETURNING id`;
        if (!changed.length) throw new PlatformFault("not_found", "Session not found");
      }
      const accounts = await tx`UPDATE accounts SET revision = revision + 1, security_revision = security_revision + ${securityChanged ? 1 : 0}, updated_at = now()
        WHERE id = ${actor.account_id} RETURNING revision::text, security_revision`;
      const account = accounts[0];
      if (securityChanged) await tx`UPDATE account_sessions SET revoked_at = now() WHERE account_id = ${actor.account_id} AND revoked_at IS NULL`;
      if (rotated) {
        await tx`UPDATE account_sessions SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${actor.session_id}`;
        const verifiedAt = securityChanged ? (command.kind === "mfa-disable" || (command.kind === 'identity-unlink' && !active) ? null : new Date()) : actor.mfa_verified_at;
        const freshUntil = securityChanged ? new Date(Math.min(Date.now() + 10 * 60000, actor.expires_at.getTime())) : actor.fresh_until;
        await tx`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until, mfa_verified_at)
          VALUES (${mutation.rotation.id}, ${actor.account_id}, ${mutation.rotation.tokenHash}, ${mutation.rotation.csrfHash}, ${account.security_revision}, ${mutation.rotation.deviceName}, ${actor.expires_at}, ${freshUntil}, ${verifiedAt})`;
      }
      await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision)
        VALUES (${randomUUID()}, ${actor.account_id}, ${actor.session_id}, ${`account.${command.kind}`}, ${mutation.requestId}, ${account.security_revision})`;
      const receipt = { message: "Account security updated", revision: account.revision as string, ...(factorId ? { factorId } : {}) };
      const persisted = disclose ? { ...receipt, oneTimeValuesUnavailable: true } : receipt;
      await tx`INSERT INTO account_security_commands (account_id, session_id, key_digest, request_digest, result)
        VALUES (${actor.account_id}, ${actor.session_id}, ${mutation.keyDigest}, ${mutation.requestDigest}, ${JSON.stringify(persisted)}::text::jsonb)`;
      return { receipt, disclose, rotated, expiresAt: rotated ? (actor.expires_at as Date).toISOString() : undefined };
    });
    if ("fault" in result) throw new PlatformFault(result.fault === "locked" ? "rate_limited" : "unauthenticated", "MFA code is invalid, already used, or temporarily locked", { code: "invalid" });
    return result;
  }
}
