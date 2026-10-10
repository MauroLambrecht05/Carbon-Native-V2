import { randomUUID } from "node:crypto";
import { PlatformFault } from "@carbon/contracts/platform";
import type { ExternalAccountRepository, ExternalFlowStart } from "../application/ports/ExternalAccountRepository.ts";
import type { ExternalAccountIdentity } from "../application/ports/ExternalAccountProvider.ts";
import type { FreshAuthBinding } from "../domain/entities/AccountIdentity.ts";
import type { PostgresMfaVerification, StoredMfaFactor } from "./PostgresMfaVerification.ts";

type Flow = Record<string, any>;
export class PostgresExternalAccountRepository implements ExternalAccountRepository {
  constructor(private readonly sql: Bun.SQL, private readonly mfa: PostgresMfaVerification) {}
  private async linkSession(tx: Bun.TransactionSQL, flow: Flow, binding?: FreshAuthBinding) {
    const rows = await tx`SELECT s.*, s.fresh_until > now() AS fresh, a.primary_email, a.security_revision AS account_security_revision FROM account_sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ${flow.bound_session_id} AND a.id = ${flow.bound_account_id} AND a.state = 'active' AND s.revoked_at IS NULL AND s.expires_at > now()
        AND s.security_revision = a.security_revision AND a.security_revision = ${flow.bound_security_revision}
        AND (s.mfa_verified_at IS NOT NULL OR NOT EXISTS (SELECT 1 FROM mfa_factors f WHERE f.account_id = a.id AND f.state = 'active'))`;
    if (!rows.length || (binding && (binding.accountId !== flow.bound_account_id || binding.sessionId !== flow.bound_session_id
      || binding.securityRevision !== String(flow.bound_security_revision) || binding.tokenHash !== rows[0].token_hash || binding.csrfHash !== rows[0].csrf_hash))) {
      throw new PlatformFault("unauthenticated", "The account linking context changed; authenticate again");
    }
    if (!rows[0].fresh) throw new PlatformFault("forbidden", "Recent authentication is required", { authentication: "fresh_required" });
    return rows[0];
  }
  async expire() {
    await this.sql`WITH expired AS (SELECT id FROM account_external_flows WHERE state IN ('pending', 'exchanging', 'ready') AND expires_at <= now() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)
      UPDATE account_external_flows SET state = 'expired', protected_start = NULL, protected_identity = NULL WHERE id IN (SELECT id FROM expired)`;
  }
  async start(input: ExternalFlowStart) {
    await this.expire();
    return this.sql.begin(async tx => {
      if (input.binding) {
        await tx`SELECT id FROM accounts WHERE id = ${input.binding.accountId} FOR UPDATE`;
        await this.linkSession(tx, { bound_account_id: input.binding.accountId, bound_session_id: input.binding.sessionId, bound_security_revision: input.binding.securityRevision }, input.binding);
      }
      const inserted = await tx`INSERT INTO account_external_flows (id, provider, purpose, state_hash, browser_hash, protected_start, request_key, request_digest, request_id, terms_version,
          redirect_path, expires_at, bound_account_id, bound_session_id, bound_security_revision)
        VALUES (${input.id}, 'github', ${input.purpose}, ${input.stateHash}, ${input.browserHash}, ${input.protectedStart}, ${input.requestKey}, ${input.requestDigest}, ${input.requestId}, ${input.termsVersion},
          ${input.redirectPath}, ${input.expiresAt}, ${input.binding?.accountId ?? null}, ${input.binding?.sessionId ?? null}, ${input.binding?.securityRevision ?? null})
        ON CONFLICT (request_key) DO NOTHING RETURNING id`;
      if (!inserted.length) {
        const previous = await tx`SELECT id, protected_start, request_digest FROM account_external_flows WHERE request_key = ${input.requestKey} AND state = 'pending' AND expires_at > now()`;
        if (!previous.length || previous[0].request_digest !== input.requestDigest) throw new PlatformFault("conflict", "Restart GitHub authorization with a new request key");
        return { id: previous[0].id as string, protectedStart: previous[0].protected_start as string };
      }
      for (const key of [...new Set(input.rateKeys)].sort()) {
        const rows = await tx`INSERT INTO account_auth_rate_limits (key_hash, window_start, requests) VALUES (${key}, now(), 1)
          ON CONFLICT (key_hash) DO UPDATE SET requests = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '15 minutes' THEN 1 ELSE account_auth_rate_limits.requests + 1 END,
            window_start = CASE WHEN account_auth_rate_limits.window_start <= now() - interval '15 minutes' THEN now() ELSE account_auth_rate_limits.window_start END RETURNING requests`;
        if (rows[0].requests > 20) throw new PlatformFault("rate_limited", "Too many GitHub authorization requests; try again later");
      }
      return { id: input.id, protectedStart: input.protectedStart };
    });
  }
  async claim(stateHash: string, browserHash: string) {
    return this.sql.begin(async tx => {
      const rows = await tx`SELECT * FROM account_external_flows WHERE state_hash = ${stateHash} AND browser_hash = ${browserHash} AND state = 'pending' AND expires_at > now()`;
      const flow = rows[0]; if (!flow) throw new PlatformFault("unauthenticated", "GitHub authorization is invalid, expired or already used");
      if (flow.bound_account_id) { await tx`SELECT id FROM accounts WHERE id = ${flow.bound_account_id} FOR UPDATE`; await this.linkSession(tx, flow); }
      const claimed = await tx`UPDATE account_external_flows SET state = 'exchanging', protected_start = NULL WHERE id = ${flow.id} AND state = 'pending' AND expires_at > now() RETURNING id`;
      if (!claimed.length) throw new PlatformFault("unauthenticated", "GitHub authorization is invalid, expired or already used");
      return { id: flow.id as string, protectedStart: flow.protected_start as string };
    });
  }
  async ready(id: string, browserHash: string, identity: ExternalAccountIdentity, protectedIdentity: string, completionHash: string) {
    await this.sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${identity.subject}`}, 1128354371))`;
      const flows = await tx`SELECT * FROM account_external_flows WHERE id = ${id} AND browser_hash = ${browserHash} AND state = 'exchanging' AND expires_at > now()`;
      const flow = flows[0]; if (!flow) throw new PlatformFault("unauthenticated", "GitHub authorization expired; start again");
      const subjects = await tx`SELECT account_id FROM account_identities WHERE provider = 'github' AND provider_subject = ${identity.subject}`;
      const accountId = flow.bound_account_id ?? subjects[0]?.account_id ?? null; let revision: string | null = null;
      if (accountId) {
        const accounts = await tx`SELECT security_revision::text, state FROM accounts WHERE id = ${accountId} FOR UPDATE`;
        if (!accounts.length || accounts[0].state !== 'active') throw new PlatformFault("unauthenticated", "This account is not available");
        revision = accounts[0].security_revision;
        if (flow.bound_account_id) await this.linkSession(tx, flow);
      }
      const updated = await tx`UPDATE account_external_flows SET state = 'ready', protected_identity = ${protectedIdentity}, completion_hash = ${completionHash},
        resolved_account_id = ${accountId}, resolved_security_revision = ${revision}
        WHERE id = ${id} AND state = 'exchanging' AND expires_at > now() RETURNING id`;
      if (!updated.length) throw new PlatformFault("unauthenticated", "GitHub authorization expired; start again");
    });
  }
  async fail(id: string) { await this.sql`UPDATE account_external_flows SET state = 'failed', protected_start = NULL, protected_identity = NULL WHERE id = ${id} AND state IN ('pending', 'exchanging', 'ready')`; }
  async proof(completionHash: string, browserHash: string) {
    const rows = await this.sql`SELECT id, purpose, protected_identity FROM account_external_flows WHERE completion_hash = ${completionHash} AND browser_hash = ${browserHash} AND state = 'ready' AND expires_at > now()`;
    if (!rows.length) throw new PlatformFault("unauthenticated", "GitHub authorization is invalid, expired or already used");
    return { id: rows[0].id as string, purpose: rows[0].purpose as 'login' | 'registration' | 'link', protectedIdentity: rows[0].protected_identity as string };
  }
  async complete(input: Parameters<ExternalAccountRepository['complete']>[0]) {
    const result = await this.sql.begin(async tx => {
      const { identity, issue } = input;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`github:${identity.subject}`}, 1128354371))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${identity.primaryEmail}, 1128354370))`;
      const discovered = await tx`SELECT * FROM account_external_flows WHERE id = ${input.proof.id} AND completion_hash = ${input.completionHash} AND browser_hash = ${input.browserHash} AND state = 'ready' AND expires_at > now()`;
      const flow = discovered[0]; if (!flow) throw new PlatformFault("unauthenticated", "GitHub authorization is invalid, expired or already used");
      const identities = await tx`SELECT account_id FROM account_identities WHERE provider = 'github' AND provider_subject = ${identity.subject}`;
      const subjectAccount = identities[0]?.account_id ?? null;
      const accountId = flow.purpose === 'link' ? flow.bound_account_id : subjectAccount;
      if (accountId !== flow.resolved_account_id) throw new PlatformFault("unauthenticated", "The identity context changed; start again");
      let account: Flow | undefined;
      if (accountId) account = (await tx`SELECT * FROM accounts WHERE id = ${accountId} FOR UPDATE`)[0];
      if (account && (account.state !== 'active' || String(account.security_revision) !== String(flow.resolved_security_revision))) throw new PlatformFault("unauthenticated", "The account security context changed; start again");
      const available = await tx`SELECT id FROM account_external_flows WHERE id = ${flow.id} AND state = 'ready' AND expires_at > now() AND protected_identity = ${input.proof.protectedIdentity} FOR UPDATE`;
      if (!available.length) throw new PlatformFault("unauthenticated", "GitHub authorization is invalid, expired or already used");
      let actor: Flow | undefined;
      if (flow.purpose === 'link') {
        if (!input.binding) throw new PlatformFault("unauthenticated", "Sign in to complete account linking");
        actor = await this.linkSession(tx, flow, input.binding);
        if (subjectAccount && subjectAccount !== accountId) throw new PlatformFault("conflict", "This GitHub identity is already linked to another account");
        if (!identity.verifiedEmails.includes(account!.primary_email)) throw new PlatformFault("forbidden", "Your current Carbon email must be verified on the GitHub account you link");
        const other = await tx`SELECT id FROM account_identities WHERE account_id = ${accountId} AND provider = 'github' AND provider_subject <> ${identity.subject}`;
        if (other.length) throw new PlatformFault("conflict", "A different GitHub identity is already linked");
      }
      if (!account) {
        if (flow.purpose !== 'registration') throw new PlatformFault("unauthenticated", "Register or sign in by email before linking this GitHub identity");
        const existing = await tx`SELECT id FROM accounts WHERE primary_email = ${identity.primaryEmail}`;
        if (existing.length) throw new PlatformFault("conflict", "Sign in by email and explicitly link GitHub", { authentication: "link_required" });
        account = (await tx`INSERT INTO accounts (id, primary_email, name, verified_at, terms_version) VALUES (${randomUUID()}, ${identity.primaryEmail}, ${identity.name}, now(), ${flow.terms_version}) RETURNING *`)[0];
        await tx`INSERT INTO account_identities (id, account_id, provider, provider_subject, verified_at) VALUES (${randomUUID()}, ${account!.id}, 'email', ${identity.primaryEmail}, now())`;
        await tx`INSERT INTO account_security_events (id, account_id, action, request_id, security_revision) VALUES (${randomUUID()}, ${account!.id}, 'account.registered', ${issue.requestId}, ${account!.security_revision})`;
      }
      const factors = await tx<StoredMfaFactor[]>`SELECT id, encrypted_secret_reference, last_counter FROM mfa_factors WHERE account_id = ${account!.id} AND state = 'active'`;
      if (factors.length) {
        if (!input.code) throw new PlatformFault("unauthenticated", "MFA verification is required", { code: "mfa_required" });
        const verified = await this.mfa.verify(tx, account!.id, factors[0]!, input.code, true);
        if (verified !== 'verified') return { fault: verified } as const;
      }
      if (!subjectAccount) await tx`INSERT INTO account_identities (id, account_id, provider, provider_subject, verified_at) VALUES (${randomUUID()}, ${account!.id}, 'github', ${identity.subject}, now())`;
      if (flow.purpose === 'link') {
        account = (await tx`UPDATE accounts SET security_revision = security_revision + 1 WHERE id = ${account!.id} RETURNING *`)[0];
        await tx`UPDATE account_sessions SET revoked_at = now() WHERE account_id = ${account!.id} AND revoked_at IS NULL`;
        await tx`INSERT INTO account_security_events (id, account_id, action, request_id, security_revision) VALUES (${randomUUID()}, ${account!.id}, 'account.github_linked', ${issue.requestId}, ${account!.security_revision})`;
      }
      const expiresAt: Date = actor ? actor.expires_at : issue.expiresAt;
      const freshUntil = new Date(Math.min(issue.freshUntil.getTime(), expiresAt.getTime()));
      await tx`UPDATE accounts SET revision = revision + 1, updated_at = now() WHERE id = ${account!.id}`;
      await tx`INSERT INTO account_sessions (id, account_id, token_hash, csrf_hash, security_revision, device_name, expires_at, fresh_until, mfa_verified_at)
        VALUES (${issue.id}, ${account!.id}, ${issue.tokenHash}, ${issue.csrfHash}, ${account!.security_revision}, ${actor?.device_name ?? issue.deviceName}, ${expiresAt}, ${freshUntil}, ${factors.length ? new Date() : null})`;
      await tx`UPDATE account_external_flows SET state = 'consumed', protected_identity = NULL, completed_at = now() WHERE id = ${flow.id}`;
      await tx`INSERT INTO account_security_events (id, account_id, session_id, action, request_id, security_revision) VALUES (${randomUUID()}, ${account!.id}, ${issue.id}, 'session.issued', ${issue.requestId}, ${account!.security_revision})`;
      return { expiresAt: expiresAt.toISOString(), returnTo: flow.redirect_path as string, linked: flow.purpose === 'link' };
    });
    if ('fault' in result) throw new PlatformFault(result.fault === 'locked' ? 'rate_limited' : 'unauthenticated', 'MFA code is invalid, already used, or temporarily locked', { code: 'invalid' });
    return result;
  }
}
