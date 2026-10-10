import { randomUUID } from 'node:crypto';
import { PlatformFault, parseComponent, type AppUser, type EnvironmentScope, type Realm } from '@carbon/contracts/platform';
import { PostgresPlatformAuthority, type OrganizationActor } from '@carbon/identity';
import type {
  AppAuthRepository, AppSession, AppUserMutation, MagicLinkRequest, OidcFlow, OidcProviderConfiguration, OidcSignIn, OidcStartRequest, RealmMutation, SessionGrant,
} from '../application/ports/AppAuthRepository.ts';

type Row = Record<string, any>;
type Tx = Bun.TransactionSQL;
const PEER_LIMIT = 20;
const EMAIL_LIMIT = 5;
const USER_LIMIT_PER_PAGE = 100;

function pgArray(value: readonly string[]) { return `{${value.map(item => `"${item.replace(/[\\"]/g, '\\$&')}"`).join(',')}}`; }
const invalidSession = () => new PlatformFault('unauthenticated', 'The app session is invalid or expired');
const invalidLink = () => new PlatformFault('unauthenticated', 'The sign-in link is invalid or expired');

export class PostgresAppAuthRepository extends PostgresPlatformAuthority implements AppAuthRepository {
  private scopeOf(row: Row): EnvironmentScope { return { orgId: row.org_id, projectId: row.project_id, environmentId: row.environment_id }; }
  private async projection(tx: Tx, row: Row): Promise<Realm> {
    const providers = await tx<Row[]>`SELECT name, issuer, client_id, client_secret_name, scopes FROM realm_providers WHERE realm_id = ${row.id} ORDER BY name`;
    return parseComponent('Realm', {
      id: row.id, scope: this.scopeOf(row), state: row.state, signupEnabled: row.signup_enabled, magicLinkEnabled: row.magic_link_enabled, sessionTtlSeconds: row.session_ttl_seconds,
      redirectAllowlist: row.redirect_allowlist, claimsRevision: row.claims_revision, revision: row.revision, createdAt: row.created_at.toISOString(),
      providers: providers.map(provider => ({ name: provider.name, issuer: provider.issuer, clientId: provider.client_id, scopes: provider.scopes, ...(provider.client_secret_name ? { clientSecretName: provider.client_secret_name } : {}) })),
    });
  }
  private async user(tx: Tx, row: Row): Promise<AppUser> {
    const identities = await tx<Row[]>`SELECT provider, verified_at FROM app_identities WHERE user_id = ${row.id} ORDER BY provider, verified_at`;
    return parseComponent('AppUser', { id: row.id, realmId: row.realm_id, email: row.email, state: row.state, lastSignedInAt: row.last_signed_in_at?.toISOString() ?? null, revision: row.revision,
      createdAt: row.created_at.toISOString(), identities: identities.map(identity => ({ provider: identity.provider, verifiedAt: identity.verified_at.toISOString() })) });
  }
  private event(tx: Tx, realm: Row, action: string, requestId: string, ids: { userId?: string | null; accountId?: string | null } = {}) {
    return tx`INSERT INTO app_auth_events (id, org_id, project_id, environment_id, realm_id, user_id, actor_account_id, action, request_id)
      VALUES (${randomUUID()}, ${realm.org_id}, ${realm.project_id}, ${realm.environment_id}, ${realm.id}, ${ids.userId ?? null}, ${ids.accountId ?? null}, ${action}, ${requestId})`;
  }

  // ── Developers ───────────────────────────────────────────────────────────

  private async developer(tx: Tx, input: OrganizationActor, scope: EnvironmentScope, write: boolean) {
    await this.lockAccounts(tx, [input.accountId], !write); const current = await this.actor(tx, input);
    const actor = { ...input, permissionRevision: current.permission_revision as string };
    const access = await this.resolveInTransaction(tx, actor, scope);
    if (!access.permissions.includes(write ? 'resources.configure' : 'metadata.read')) throw new PlatformFault('forbidden', write ? 'Configuring app authentication is not permitted' : 'Reading app authentication is not permitted');
    return { actor, fresh: !!current.fresh };
  }
  private realmRow(tx: Tx, scope: EnvironmentScope, lock = false) {
    return lock
      ? tx<Row[]>`SELECT *, revision::text, claims_revision::text FROM realms WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId} FOR UPDATE`
      : tx<Row[]>`SELECT *, revision::text, claims_revision::text FROM realms WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}`;
  }
  private async replay(tx: Tx, accountId: string, key: string, input: { keyDigest: string; requestDigest: string }) {
    const old = (await tx`SELECT request_digest, result FROM realm_commands WHERE actor_account_id = ${accountId} AND scope_key = ${key} AND key_digest = ${input.keyDigest}`)[0];
    if (old && old.request_digest !== input.requestDigest) throw new PlatformFault('conflict', 'The idempotency key was used for another command');
    return old;
  }

  async realm(input: OrganizationActor, scope: EnvironmentScope) {
    return this.sql.begin(async tx => {
      await this.developer(tx, input, scope, false);
      const row = (await this.realmRow(tx, scope))[0];
      if (!row) throw new PlatformFault('not_found', 'App authentication is not configured for this environment');
      return this.projection(tx, row);
    });
  }

  async executeRealm(input: RealmMutation) {
    return this.sql.begin(async tx => {
      const scope = input.scope; const command = input.command;
      await tx`SELECT id FROM environments WHERE id = ${scope.environmentId} AND project_id = ${scope.projectId} AND org_id = ${scope.orgId} FOR UPDATE`;
      const { actor, fresh } = await this.developer(tx, input.actor, scope, true);
      const key = `realm:${scope.environmentId}`; const old = await this.replay(tx, actor.accountId, key, input);
      if (old) return parseComponent('RealmReceipt', old.result);
      if (!fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });
      let row = (await this.realmRow(tx, scope, true))[0]; let action = `realm.${command.kind}`;
      if (!row) {
        // The first configure creates the realm; nothing else can run before it exists.
        if (command.kind !== 'configure') throw new PlatformFault('not_found', 'App authentication is not configured for this environment');
        row = (await tx<Row[]>`INSERT INTO realms (id, org_id, project_id, environment_id, signup_enabled, magic_link_enabled, session_ttl_seconds, redirect_allowlist, created_by)
          VALUES (${input.realmId}, ${scope.orgId}, ${scope.projectId}, ${scope.environmentId}, ${command.signupEnabled}, ${command.magicLinkEnabled}, ${command.sessionTtlSeconds},
            ${pgArray(command.redirectAllowlist)}::text[], ${actor.accountId}) RETURNING *, revision::text, claims_revision::text`)[0]!;
        action = 'realm.created';
      } else {
        if (row.revision !== input.expectedRevision) throw new PlatformFault('conflict', 'App authentication changed; refresh before retrying');
        if (command.kind === 'configure') {
          await tx`UPDATE realms SET signup_enabled = ${command.signupEnabled}, magic_link_enabled = ${command.magicLinkEnabled}, session_ttl_seconds = ${command.sessionTtlSeconds},
            redirect_allowlist = ${pgArray(command.redirectAllowlist)}::text[] WHERE id = ${row.id}`;
        } else if (command.kind === 'state') {
          if ((row.state === 'disabled') === command.disabled) throw new PlatformFault('conflict', command.disabled ? 'App authentication is already disabled' : 'App authentication is already active');
          await tx`UPDATE realms SET state = ${command.disabled ? 'disabled' : 'active'} WHERE id = ${row.id}`;
        } else if (command.kind === 'invalidate-sessions') {
          await tx`UPDATE realms SET claims_revision = claims_revision + 1 WHERE id = ${row.id}`;
        } else if (command.kind === 'provider-set') {
          if (command.clientSecretName && !(await tx`SELECT 1 FROM environment_secrets WHERE org_id = ${scope.orgId} AND project_id = ${scope.projectId} AND environment_id = ${scope.environmentId}
            AND name = ${command.clientSecretName} AND state = 'active'`).length) throw new PlatformFault('validation', 'The client secret is not an active secret of this environment');
          if ((await tx`SELECT 1 FROM realm_providers WHERE realm_id = ${row.id} AND name <> ${command.name}`).length >= 10) throw new PlatformFault('quota', 'Too many identity providers');
          await tx`INSERT INTO realm_providers (id, realm_id, name, issuer, client_id, client_secret_name, scopes)
            VALUES (${randomUUID()}, ${row.id}, ${command.name}, ${command.issuer.replace(/\/+$/, '')}, ${command.clientId}, ${command.clientSecretName ?? null}, ${pgArray(command.scopes)}::text[])
            ON CONFLICT (realm_id, name) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id, client_secret_name = EXCLUDED.client_secret_name, scopes = EXCLUDED.scopes`;
        } else {
          if (!(await tx`DELETE FROM realm_providers WHERE realm_id = ${row.id} AND name = ${command.name} RETURNING id`).length) throw new PlatformFault('not_found', 'Identity provider not found');
        }
        // Any in-flight sign-in was started under the old configuration.
        await tx`UPDATE app_challenges SET consumed_at = now() WHERE realm_id = ${row.id} AND consumed_at IS NULL`;
        row = (await tx<Row[]>`UPDATE realms SET revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING *, revision::text, claims_revision::text`)[0]!;
      }
      const receipt = parseComponent('RealmReceipt', { realm: await this.projection(tx, row), message: action === 'realm.created' ? 'App authentication configured' : 'App authentication updated' });
      await tx`INSERT INTO realm_commands VALUES (${actor.accountId}, ${key}, ${input.keyDigest}, ${input.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb, now())`;
      await this.event(tx, row, action, input.requestId, { accountId: actor.accountId });
      return receipt;
    });
  }

  async users(input: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string) {
    return this.sql.begin(async tx => {
      await this.developer(tx, input, scope, false);
      const realm = (await this.realmRow(tx, scope))[0];
      if (!realm) throw new PlatformFault('not_found', 'App authentication is not configured for this environment');
      const rows = await tx<Row[]>`SELECT *, revision::text FROM app_users WHERE realm_id = ${realm.id} AND state <> 'deleted'
        AND (${afterId ?? null}::uuid IS NULL OR id > ${afterId ?? null}::uuid) ORDER BY id LIMIT ${Math.min(limit, USER_LIMIT_PER_PAGE + 1)}`;
      return Promise.all(rows.map(row => this.user(tx, row)));
    });
  }

  async executeUser(input: AppUserMutation) {
    return this.sql.begin(async tx => {
      const { actor, fresh } = await this.developer(tx, input.actor, input.scope, true);
      const realm = (await this.realmRow(tx, input.scope))[0];
      const row = realm ? (await tx<Row[]>`SELECT *, revision::text FROM app_users WHERE id = ${input.userId} AND realm_id = ${realm.id} AND state <> 'deleted' FOR UPDATE`)[0] : undefined;
      if (!realm || !row) throw new PlatformFault('not_found', 'App user not found');
      const key = `app-user:${row.id}`; const old = await this.replay(tx, actor.accountId, key, input);
      if (old) return parseComponent('AppUserReceipt', old.result);
      if (!fresh) throw new PlatformFault('forbidden', 'Recent authentication is required', { authentication: 'fresh_required' });
      if (row.revision !== input.expectedRevision) throw new PlatformFault('conflict', 'App user changed; refresh before retrying');
      const kind = input.command.kind;
      if (kind === 'suspend' && row.state !== 'active') throw new PlatformFault('conflict', 'Only an active user can be suspended');
      if (kind === 'restore' && row.state !== 'suspended') throw new PlatformFault('conflict', 'Only a suspended user can be restored');
      const state = kind === 'suspend' ? 'suspended' : kind === 'restore' ? 'active' : kind === 'delete' ? 'deleted' : row.state;
      // Every one of these ends the user's current sessions; restore does not bring old ones back.
      await tx`UPDATE app_sessions SET revoked_at = now() WHERE user_id = ${row.id} AND revoked_at IS NULL`;
      const updated = (await tx<Row[]>`UPDATE app_users SET state = ${state}, revision = revision + 1, updated_at = now() WHERE id = ${row.id} RETURNING *, revision::text`)[0]!;
      const receipt = parseComponent('AppUserReceipt', { user: await this.user(tx, updated), message: kind === 'suspend' ? 'User suspended' : kind === 'restore' ? 'User restored' : kind === 'delete' ? 'User deleted' : 'User sessions revoked' });
      await tx`INSERT INTO realm_commands VALUES (${actor.accountId}, ${key}, ${input.keyDigest}, ${input.requestDigest}, ${JSON.stringify(receipt)}::text::jsonb, now())`;
      await this.event(tx, realm, `app_user.${kind}`, input.requestId, { userId: row.id, accountId: actor.accountId });
      return receipt;
    });
  }

  // ── The app and its end users ────────────────────────────────────────────

  /** A realm is usable only while it, its environment, project and organization are all active. */
  private async liveRealm(tx: Tx, realmId: string, lock = false): Promise<Row> {
    const rows = lock
      ? await tx<Row[]>`SELECT r.*, r.claims_revision::text FROM realms r JOIN environments e ON e.id = r.environment_id JOIN projects p ON p.id = r.project_id JOIN organizations o ON o.id = r.org_id
          WHERE r.id = ${realmId} AND r.state = 'active' AND e.state = 'active' AND p.state = 'active' AND o.state = 'active' FOR SHARE OF r`
      : await tx<Row[]>`SELECT r.*, r.claims_revision::text FROM realms r JOIN environments e ON e.id = r.environment_id JOIN projects p ON p.id = r.project_id JOIN organizations o ON o.id = r.org_id
          WHERE r.id = ${realmId} AND r.state = 'active' AND e.state = 'active' AND p.state = 'active' AND o.state = 'active'`;
    if (!rows.length) throw new PlatformFault('not_found', 'App authentication is not available');
    return rows[0]!;
  }
  private async limited(tx: Tx, realmId: string, digest: string, limit: number): Promise<boolean> {
    const count = (await tx<{ count: number }[]>`INSERT INTO app_auth_rate_limits (realm_id, key_digest, window_started_at, request_count)
      VALUES (${realmId}, ${digest}, to_timestamp(floor(extract(epoch from now()) / 900) * 900), 1)
      ON CONFLICT (realm_id, key_digest, window_started_at) DO UPDATE SET request_count = app_auth_rate_limits.request_count + 1 RETURNING request_count AS count`)[0]!.count;
    return count > limit;
  }
  private allowed(realm: Row, redirectUri: string) {
    if (!(realm.redirect_allowlist as string[]).includes(redirectUri)) throw new PlatformFault('validation', 'The redirect URI is not allowed for this app');
  }

  async configuration(realmId: string) {
    return this.sql.begin(async tx => {
      const realm = await this.liveRealm(tx, realmId);
      const providers = await tx<{ name: string }[]>`SELECT name FROM realm_providers WHERE realm_id = ${realm.id} ORDER BY name`;
      return parseComponent('AppRealmConfiguration', { realmId: realm.id, signupEnabled: realm.signup_enabled, magicLinkEnabled: realm.magic_link_enabled, providers: providers.map(provider => ({ name: provider.name })) });
    });
  }

  async origins(realmId: string) {
    return this.sql.begin(async tx => {
      const realm = await this.liveRealm(tx, realmId);
      return [...new Set((realm.redirect_allowlist as string[]).map(uri => new URL(uri).origin).filter(origin => origin !== 'null'))];
    });
  }

  async requestMagicLink(input: MagicLinkRequest) {
    // The peer limit is a refusal and must be committed; everything after it either sends or silently does not.
    const refused = await this.sql.begin(async tx => {
      const realm = await this.liveRealm(tx, input.realmId, true);
      if (!realm.magic_link_enabled) throw new PlatformFault('validation', 'Email sign-in is not enabled for this app');
      this.allowed(realm, input.redirectUri);
      if (await this.limited(tx, realm.id, input.peerDigest, PEER_LIMIT)) return true;
      if (await this.limited(tx, realm.id, input.emailDigest, EMAIL_LIMIT)) return false;
      const user = (await tx<Row[]>`SELECT state FROM app_users WHERE realm_id = ${realm.id} AND email = ${input.email} AND state <> 'deleted'`)[0];
      if (user ? user.state !== 'active' : !realm.signup_enabled) return false;
      await tx`INSERT INTO app_challenges (id, realm_id, kind, email, token_hash, redirect_uri, claims_revision, expires_at, request_id)
        VALUES (${input.challengeId}, ${realm.id}, 'magic_link', ${input.email}, ${input.tokenHash}, ${input.redirectUri}, ${realm.claims_revision}, ${input.expiresAt}, ${input.requestId})`;
      await tx`INSERT INTO app_email_outbox (id, protected_message, expires_at) VALUES (${input.challengeId}, ${input.protectedMessage}, ${input.expiresAt})`;
      return false;
    });
    if (refused) throw new PlatformFault('rate_limited', 'Too many sign-in requests');
  }

  private async grant(tx: Tx, realm: Row, user: Row, grant: SessionGrant, action: string): Promise<AppSession> {
    const session = (await tx<Row[]>`INSERT INTO app_sessions (id, user_id, realm_id, token_hash, claims_revision, expires_at)
      VALUES (${grant.sessionId}, ${user.id}, ${realm.id}, ${grant.tokenHash}, ${realm.claims_revision}, now() + make_interval(secs => ${realm.session_ttl_seconds})) RETURNING expires_at`)[0]!;
    await tx`UPDATE app_users SET last_signed_in_at = now(), updated_at = now() WHERE id = ${user.id}`;
    await this.event(tx, realm, action, grant.requestId, { userId: user.id });
    return { sessionId: grant.sessionId, userId: user.id, email: user.email, realmId: realm.id, scope: this.scopeOf(realm), claimsRevision: realm.claims_revision, expiresAt: session.expires_at };
  }
  /** Finds the user for a verified email, or creates one when signup is open. A suspended user never signs in. */
  private async admit(tx: Tx, realm: Row, email: string, provider: string, subject: string): Promise<{ user: Row; created: boolean }> {
    const known = (await tx<Row[]>`SELECT u.* FROM app_identities i JOIN app_users u ON u.id = i.user_id WHERE i.realm_id = ${realm.id} AND i.provider = ${provider} AND i.subject = ${subject} AND u.state <> 'deleted' FOR UPDATE OF u`)[0];
    let user = known ?? (await tx<Row[]>`SELECT * FROM app_users WHERE realm_id = ${realm.id} AND email = ${email} AND state <> 'deleted' FOR UPDATE`)[0];
    let created = false;
    if (!user) {
      if (!realm.signup_enabled) throw invalidLink();
      user = (await tx<Row[]>`INSERT INTO app_users (id, realm_id, email) VALUES (${randomUUID()}, ${realm.id}, ${email}) RETURNING *`)[0]!; created = true;
    }
    if (user.state !== 'active') throw invalidLink();
    if (!known) await tx`INSERT INTO app_identities (id, user_id, realm_id, provider, subject) VALUES (${randomUUID()}, ${user.id}, ${realm.id}, ${provider}, ${subject}) ON CONFLICT DO NOTHING`;
    return { user, created };
  }

  async consumeMagicLink(realmId: string, tokenHash: string, grant: SessionGrant) {
    return this.sql.begin(async tx => {
      const realm = await this.liveRealm(tx, realmId, true);
      const challenge = (await tx<Row[]>`UPDATE app_challenges SET consumed_at = now() WHERE realm_id = ${realm.id} AND kind = 'magic_link' AND token_hash = ${tokenHash}
        AND consumed_at IS NULL AND expires_at > now() AND claims_revision = ${realm.claims_revision} RETURNING email`)[0];
      if (!challenge || !realm.magic_link_enabled) throw invalidLink();
      const { user, created } = await this.admit(tx, realm, challenge.email, 'email', challenge.email);
      return this.grant(tx, realm, user, grant, created ? 'app_user.signed_up' : 'app_user.signed_in');
    });
  }

  private async liveSession(tx: Tx, realmId: string, tokenHash: string): Promise<{ realm: Row; session: Row }> {
    const realm = await this.liveRealm(tx, realmId).catch(() => { throw invalidSession(); });
    const session = (await tx<Row[]>`SELECT s.*, s.claims_revision::text, u.email, u.state AS user_state FROM app_sessions s JOIN app_users u ON u.id = s.user_id
      WHERE s.realm_id = ${realm.id} AND s.token_hash = ${tokenHash} FOR UPDATE OF s`)[0];
    if (!session || session.revoked_at || session.expires_at <= new Date() || session.user_state !== 'active' || session.claims_revision !== realm.claims_revision) throw invalidSession();
    return { realm, session };
  }
  private view(realm: Row, session: Row): AppSession {
    return { sessionId: session.id, userId: session.user_id, email: session.email, realmId: realm.id, scope: this.scopeOf(realm), claimsRevision: session.claims_revision, expiresAt: session.expires_at };
  }

  async session(realmId: string, tokenHash: string) {
    return this.sql.begin(async tx => {
      const { realm, session } = await this.liveSession(tx, realmId, tokenHash);
      await tx`UPDATE app_sessions SET last_used_at = now() WHERE id = ${session.id}`;
      return this.view(realm, session);
    });
  }
  async rotate(realmId: string, tokenHash: string, nextTokenHash: string, requestId: string) {
    return this.sql.begin(async tx => {
      const { realm, session } = await this.liveSession(tx, realmId, tokenHash);
      // Same session, new token: the old token stops at once and the lifetime is not extended.
      await tx`UPDATE app_sessions SET token_hash = ${nextTokenHash}, last_used_at = now() WHERE id = ${session.id}`;
      await this.event(tx, realm, 'app_user.session_rotated', requestId, { userId: session.user_id });
      return this.view(realm, session);
    });
  }
  async revoke(realmId: string, tokenHash: string, requestId: string) {
    await this.sql.begin(async tx => {
      const { realm, session } = await this.liveSession(tx, realmId, tokenHash);
      await tx`UPDATE app_sessions SET revoked_at = now() WHERE id = ${session.id}`;
      await this.event(tx, realm, 'app_user.signed_out', requestId, { userId: session.user_id });
    });
  }

  private provider(row: Row): OidcProviderConfiguration { return { name: row.name, issuer: row.issuer, clientId: row.client_id, clientSecretName: row.client_secret_name ?? null, scopes: row.scopes }; }

  async startOidc(input: OidcStartRequest) {
    const outcome = await this.sql.begin(async tx => {
      const realm = await this.liveRealm(tx, input.realmId, true);
      this.allowed(realm, input.redirectUri);
      const provider = (await tx<Row[]>`SELECT * FROM realm_providers WHERE realm_id = ${realm.id} AND name = ${input.provider}`)[0];
      if (!provider) throw new PlatformFault('not_found', 'Identity provider not found');
      if (await this.limited(tx, realm.id, input.peerDigest, PEER_LIMIT)) return undefined;
      await tx`INSERT INTO app_challenges (id, realm_id, kind, state_hash, provider_name, protected_flow, redirect_uri, claims_revision, expires_at, request_id)
        VALUES (${input.challengeId}, ${realm.id}, 'oidc', ${input.stateHash}, ${provider.name}, ${input.protectedFlow}, ${input.redirectUri}, ${realm.claims_revision}, ${input.expiresAt}, ${input.requestId})`;
      return this.provider(provider);
    });
    if (!outcome) throw new PlatformFault('rate_limited', 'Too many sign-in requests');
    return outcome;
  }

  /** Consumes the state before anything is sent to the provider, so one authorization can be completed once. */
  async takeOidc(realmId: string, stateHash: string): Promise<OidcFlow> {
    return this.sql.begin(async tx => {
      const realm = await this.liveRealm(tx, realmId, true);
      const challenge = (await tx<Row[]>`UPDATE app_challenges SET consumed_at = now() WHERE realm_id = ${realm.id} AND kind = 'oidc' AND state_hash = ${stateHash}
        AND consumed_at IS NULL AND expires_at > now() AND claims_revision = ${realm.claims_revision} RETURNING id, provider_name, protected_flow, redirect_uri`)[0];
      const provider = challenge ? (await tx<Row[]>`SELECT * FROM realm_providers WHERE realm_id = ${realm.id} AND name = ${challenge.provider_name}`)[0] : undefined;
      if (!challenge || !provider) throw invalidLink();
      return { challengeId: challenge.id, provider: this.provider(provider), protectedFlow: challenge.protected_flow, redirectUri: challenge.redirect_uri, scope: this.scopeOf(realm) };
    });
  }

  async signInOidc(input: OidcSignIn) {
    return this.sql.begin(async tx => {
      const realm = await this.liveRealm(tx, input.realmId, true);
      if (!(await tx`SELECT 1 FROM realm_providers WHERE realm_id = ${realm.id} AND name = ${input.provider}`).length) throw invalidLink();
      const { user, created } = await this.admit(tx, realm, input.email, input.provider, input.subject);
      return this.grant(tx, realm, user, input, created ? 'app_user.signed_up' : 'app_user.signed_in');
    });
  }
}
