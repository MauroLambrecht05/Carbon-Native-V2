import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { OidcClient, OidcIdentity, OidcProviderConfiguration } from '../application/ports/AppAuthRepository.ts';

interface Discovery { readonly authorization_endpoint: string; readonly token_endpoint: string; readonly jwks_uri: string }
const failure = () => new Error('The identity provider could not complete sign-in');

/**
 * OpenID Connect authorization code flow with PKCE. The ID token's signature, issuer, audience, expiry and nonce are
 * all verified against the provider's published keys, and only a provider-verified email is accepted.
 */
export class HttpOidcClient implements OidcClient {
  constructor(private readonly transport: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {}

  private https(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048) throw failure();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw failure();
    return url.href;
  }
  private async json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try { response = await this.transport(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch { throw failure(); }
    if (response.status !== 200) { await response.body?.cancel(); throw failure(); }
    const text = await response.text();
    if (text.length > 262144) throw failure();
    try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; } catch { throw failure(); }
  }
  /** Discovery must come from the configured issuer and name that same issuer back. */
  private async discover(provider: OidcProviderConfiguration): Promise<Discovery> {
    const document = await this.json(`${provider.issuer}/.well-known/openid-configuration`);
    if (typeof document.issuer !== 'string' || document.issuer.replace(/\/+$/, '') !== provider.issuer) throw failure();
    return { authorization_endpoint: this.https(document.authorization_endpoint), token_endpoint: this.https(document.token_endpoint), jwks_uri: this.https(document.jwks_uri) };
  }

  async authorizationUrl(provider: OidcProviderConfiguration, input: { redirectUri: string; state: string; codeChallenge: string; nonce: string }): Promise<string> {
    const url = new URL((await this.discover(provider)).authorization_endpoint);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: provider.clientId, redirect_uri: input.redirectUri, scope: [...new Set(['openid', 'email', ...provider.scopes])].join(' '),
      state: input.state, nonce: input.nonce, code_challenge: input.codeChallenge, code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return url.href;
  }

  async exchange(provider: OidcProviderConfiguration, input: { redirectUri: string; code: string; codeVerifier: string; nonce: string; clientSecret?: string }): Promise<OidcIdentity> {
    const discovery = await this.discover(provider);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, client_id: provider.clientId, code_verifier: input.codeVerifier });
    if (input.clientSecret) body.set('client_secret', input.clientSecret);
    const tokens = await this.json(discovery.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() });
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 16384) throw failure();
    const keys = await this.json(discovery.jwks_uri);
    let claims: Record<string, unknown>;
    try {
      claims = (await jwtVerify(tokens.id_token, createLocalJWKSet(keys as unknown as JSONWebKeySet), { issuer: [provider.issuer, `${provider.issuer}/`], audience: provider.clientId,
        algorithms: ['RS256', 'ES256', 'EdDSA', 'PS256'], currentDate: this.now(), clockTolerance: 30 })).payload;
    } catch { throw failure(); }
    if (claims.nonce !== input.nonce || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || typeof claims.exp !== 'number') throw failure();
    // An unverified address must never be linked to, or create, a user.
    if (typeof claims.email !== 'string' || claims.email.length > 254 || claims.email_verified !== true) throw failure();
    return { subject: claims.sub, email: claims.email.toLowerCase() };
  }
}
