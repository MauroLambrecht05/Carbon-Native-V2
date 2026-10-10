import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  PlatformFault, parseComponent, type AppAssertionExchange, type AppAssertionResponse, type AppChallengeReceipt, type AppChallengeRequest, type AppOidcComplete, type AppOidcStart,
  type AppOidcStartResponse, type AppRealmConfiguration, type AppSessionIssue, type AppSessionRequest, type AppSessionView, type AppUserCommand, type AppUserPage, type AppUserReceipt,
  type CommandOptions, type EnvironmentScope, type PageRequest, type Realm, type RealmCommand, type RealmReceipt,
} from '@carbon/contracts/platform';
import { tokenDigest, tokenMatches, type AccountAuthentication, type MessageProtector, type OrganizationActor, type ServiceAssertionIssuer } from '@carbon/identity';
import type { AppAuthRepository, AppSession, OidcClient, ProviderSecretReader } from '../ports/AppAuthRepository.ts';

const CHALLENGE_MS = 15 * 60_000;
const GENERIC = 'If sign-in is available for this address, a link has been sent.';
function opaque(prefix: 'am' | 'aps' | 'ao') { return `${prefix}_${randomBytes(32).toString('base64url')}`; }

/** Developers configure a realm and manage its users through the browser session. */
export class AccountRealms {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: AppAuthRepository, private readonly cursors: MessageProtector) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault('unauthenticated', 'Sign in to manage app authentication');
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault('forbidden', 'Invalid CSRF token');
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }

  async get(token: string, input: EnvironmentScope): Promise<Realm> { return this.repository.realm(await this.actor(token), parseComponent('EnvironmentScope', input)); }

  async command(token: string, csrf: string, input: EnvironmentScope, value: RealmCommand, options: CommandOptions, requestId: string): Promise<RealmReceipt> {
    const scope = parseComponent('EnvironmentScope', input); const command = parseComponent('RealmCommand', value); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (command.kind === 'configure') for (const uri of command.redirectAllowlist) {
      // Exact-match allowlist: no wildcards, no fragments, and plain http only for a local development callback.
      const url = new URL(uri);
      if (url.hash || uri.includes('*') || url.username || url.password || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || ['javascript:', 'data:', 'file:', 'vbscript:'].includes(url.protocol)) throw new PlatformFault('validation', 'A redirect URI is not allowed');
    }
    return this.repository.executeRealm({ actor: await this.actor(token, csrf), scope, realmId: randomUUID(), command, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ scope, command, expectedRevision: options.expectedRevision ?? null })), requestId });
  }

  async users(token: string, input: EnvironmentScope, query: PageRequest): Promise<AppUserPage> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('PageRequest', query);
    if (query.filter || (query.sort && query.sort !== 'id')) throw new PlatformFault('validation', 'Only ID ordering is supported');
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const context = `app-users:${actor.sessionId}:${actor.permissionRevision}:${scope.environmentId}:${limit}`; let afterId: string | undefined;
    if (query.cursor) try { afterId = parseComponent('Id', JSON.parse(await this.cursors.open(query.cursor, context)).afterId); } catch { throw new PlatformFault('validation', 'The page cursor is invalid or expired'); }
    const rows = await this.repository.users(actor, scope, limit + 1, afterId); const items = rows.slice(0, limit);
    return parseComponent('AppUserPage', { items, nextCursor: rows[limit] && items.length ? await this.cursors.seal(JSON.stringify({ afterId: items.at(-1)!.id }), context) : null });
  }

  async userCommand(token: string, csrf: string, input: EnvironmentScope, userId: string, value: AppUserCommand, options: CommandOptions, requestId: string): Promise<AppUserReceipt> {
    const scope = parseComponent('EnvironmentScope', input); parseComponent('Id', userId); const command = parseComponent('AppUserCommand', value); parseComponent('CommandOptions', options); parseComponent('Id', requestId);
    if (!options.expectedRevision) throw new PlatformFault('validation', 'A current revision is required');
    return this.repository.executeUser({ actor: await this.actor(token, csrf), scope, userId, command, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ scope, userId, command, expectedRevision: options.expectedRevision })), requestId });
  }
}

export interface AppAuthenticationConfig { readonly rateLimitKey: string; readonly now?: () => Date }

/** What an app and its end users can do: discover the realm, sign in, hold a session, and exchange it for a Database assertion. */
export class AppAuthentication {
  private readonly now: () => Date;
  constructor(private readonly repository: AppAuthRepository, private readonly protector: MessageProtector, private readonly config: AppAuthenticationConfig,
    private readonly oidc?: OidcClient, private readonly secrets?: ProviderSecretReader, private readonly issuer?: ServiceAssertionIssuer) { this.now = config.now ?? (() => new Date()); }

  /** Keyed, so neither a network address nor an email address is stored to count requests. */
  private digest(kind: 'peer' | 'email', realmId: string, value: string) { return createHmac('sha256', this.config.rateLimitKey).update(`${kind}:${realmId}:${value}`).digest('hex'); }
  private bearer(authorization: string): string {
    const match = /^Bearer (aps_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) throw new PlatformFault('unauthenticated', 'An app session is required');
    return tokenDigest(match[1]!);
  }
  private issue(session: AppSession, token: string): AppSessionIssue {
    return parseComponent('AppSessionIssue', { token, expiresAt: session.expiresAt.toISOString(), user: { id: session.userId, email: session.email } });
  }

  async configuration(realmId: string): Promise<AppRealmConfiguration> { parseComponent('Id', realmId); return this.repository.configuration(realmId); }

  /** Always answers the same way: whether the address has an account, may sign up, or was sent anything is never revealed. */
  async challenge(realmId: string, value: AppChallengeRequest, peer: string, requestId: string): Promise<AppChallengeReceipt> {
    parseComponent('Id', realmId); parseComponent('Id', requestId); const input = parseComponent('AppChallengeRequest', value);
    const email = input.email.trim().toLowerCase(); const token = opaque('am'); const challengeId = randomUUID();
    const link = `${input.redirectUri}#token=${token}`;
    const protectedMessage = await this.protector.seal(JSON.stringify({ to: email, subject: 'Your sign-in link', text: `Use this link to sign in. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for it, ignore this message.` }), challengeId);
    await this.repository.requestMagicLink({ realmId, challengeId, email, redirectUri: input.redirectUri, tokenHash: tokenDigest(token), protectedMessage,
      peerDigest: this.digest('peer', realmId, peer), emailDigest: this.digest('email', realmId, email), expiresAt: new Date(this.now().getTime() + CHALLENGE_MS), requestId });
    return parseComponent('AppChallengeReceipt', { message: GENERIC });
  }

  async signIn(realmId: string, value: AppSessionRequest, requestId: string): Promise<AppSessionIssue> {
    parseComponent('Id', realmId); parseComponent('Id', requestId); const input = parseComponent('AppSessionRequest', value); const token = opaque('aps');
    return this.issue(await this.repository.consumeMagicLink(realmId, tokenDigest(input.token), { sessionId: randomUUID(), tokenHash: tokenDigest(token), requestId }), token);
  }

  async view(realmId: string, authorization: string): Promise<AppSessionView> {
    parseComponent('Id', realmId); const session = await this.repository.session(realmId, this.bearer(authorization));
    return parseComponent('AppSessionView', { user: { id: session.userId, email: session.email }, expiresAt: session.expiresAt.toISOString() });
  }
  async rotate(realmId: string, authorization: string, requestId: string): Promise<AppSessionIssue> {
    parseComponent('Id', realmId); parseComponent('Id', requestId); const token = opaque('aps');
    return this.issue(await this.repository.rotate(realmId, this.bearer(authorization), tokenDigest(token), requestId), token);
  }
  async signOut(realmId: string, authorization: string, requestId: string): Promise<void> { parseComponent('Id', realmId); parseComponent('Id', requestId); await this.repository.revoke(realmId, this.bearer(authorization), requestId); }

  async oidcStart(realmId: string, value: AppOidcStart, peer: string, requestId: string): Promise<AppOidcStartResponse> {
    if (!this.oidc) throw new PlatformFault('capability', 'Identity providers are not configured');
    parseComponent('Id', realmId); parseComponent('Id', requestId); const input = parseComponent('AppOidcStart', value);
    const state = opaque('ao'); const challengeId = randomUUID(); const codeVerifier = randomBytes(32).toString('base64url'); const nonce = randomBytes(16).toString('base64url');
    const provider = await this.repository.startOidc({ realmId, challengeId, provider: input.provider, redirectUri: input.redirectUri, stateHash: tokenDigest(state),
      protectedFlow: await this.protector.seal(JSON.stringify({ codeVerifier, nonce }), challengeId), peerDigest: this.digest('peer', realmId, peer), expiresAt: new Date(this.now().getTime() + CHALLENGE_MS), requestId });
    let authorizationUrl: string;
    try { authorizationUrl = await this.oidc.authorizationUrl(provider, { redirectUri: input.redirectUri, state, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'), nonce }); }
    catch { throw new PlatformFault('unavailable', 'The identity provider could not be reached'); }
    return parseComponent('AppOidcStartResponse', { authorizationUrl });
  }

  async oidcComplete(realmId: string, value: AppOidcComplete, requestId: string): Promise<AppSessionIssue> {
    if (!this.oidc) throw new PlatformFault('capability', 'Identity providers are not configured');
    parseComponent('Id', realmId); parseComponent('Id', requestId); const input = parseComponent('AppOidcComplete', value);
    const flow = await this.repository.takeOidc(realmId, tokenDigest(input.state));
    let identity;
    try {
      const sealed = JSON.parse(await this.protector.open(flow.protectedFlow, flow.challengeId)) as { codeVerifier: string; nonce: string };
      const clientSecret = flow.provider.clientSecretName ? await this.requireSecrets().read(flow.scope, flow.provider.clientSecretName) : undefined;
      identity = await this.oidc.exchange(flow.provider, { redirectUri: flow.redirectUri, code: input.code, codeVerifier: sealed.codeVerifier, nonce: sealed.nonce, clientSecret });
    } catch (error) {
      if (error instanceof PlatformFault && error.code === 'capability') throw error;
      // Provider and decryption detail is never surfaced; the state is already spent.
      throw new PlatformFault('unauthenticated', 'The sign-in link is invalid or expired');
    }
    const token = opaque('aps');
    return this.issue(await this.repository.signInOidc({ realmId, provider: flow.provider.name, subject: identity.subject, email: identity.email, sessionId: randomUUID(), tokenHash: tokenDigest(token), requestId }), token);
  }
  private requireSecrets(): ProviderSecretReader { if (!this.secrets) throw new PlatformFault('capability', 'Provider secrets are not configured'); return this.secrets; }

  /**
   * Exchanges a live app session for a 60-second assertion bound to one exact Database request. The principal is the
   * app user; the scope carries the realm; the only permissions an app user can ever name are data.read and data.write.
   */
  async exchange(realmId: string, authorization: string, value: AppAssertionExchange, requestId: string): Promise<AppAssertionResponse> {
    if (!this.issuer) throw new PlatformFault('capability', 'App assertion exchange is not configured');
    parseComponent('Id', realmId); parseComponent('Id', requestId); const input = parseComponent('AppAssertionExchange', value);
    const session = await this.repository.session(realmId, this.bearer(authorization));
    if (input.scope.orgId !== session.scope.orgId || input.scope.projectId !== session.scope.projectId || input.scope.environmentId !== session.scope.environmentId) throw new PlatformFault('forbidden', 'The request is outside this app');
    const scope = { ...session.scope, realmId: session.realmId };
    const principal = parseComponent('Principal', { id: session.userId, kind: 'app_user', audience: 'app', credentialId: session.sessionId, permissionRevision: session.claimsRevision });
    const token = await this.issuer.issue({ aud: input.audience, principal, scope, roles: [], grants: [{ permission: input.permission, scope }], requestId, request: input.request });
    return parseComponent('AppAssertionResponse', { tokenType: 'Bearer', token, expiresInSeconds: 60 });
  }
}
