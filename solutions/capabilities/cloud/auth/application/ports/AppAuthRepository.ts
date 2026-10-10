import type {
  AppRealmConfiguration, AppUser, AppUserCommand, AppUserReceipt, EnvironmentScope, Realm, RealmCommand, RealmReceipt,
} from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

export interface RealmMutation {
  readonly actor: OrganizationActor; readonly scope: EnvironmentScope; readonly realmId: string; readonly command: RealmCommand;
  readonly expectedRevision?: string; readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}
export interface AppUserMutation {
  readonly actor: OrganizationActor; readonly scope: EnvironmentScope; readonly userId: string; readonly command: AppUserCommand;
  readonly expectedRevision: string; readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}
/** What a verified app session stands for right now. */
export interface AppSession {
  readonly sessionId: string; readonly userId: string; readonly email: string; readonly realmId: string; readonly scope: EnvironmentScope;
  readonly claimsRevision: string; readonly expiresAt: Date;
}
export interface MagicLinkRequest {
  readonly realmId: string; readonly challengeId: string; readonly email: string; readonly redirectUri: string; readonly tokenHash: string; readonly protectedMessage: string;
  readonly peerDigest: string; readonly emailDigest: string; readonly expiresAt: Date; readonly requestId: string;
}
export interface SessionGrant { readonly sessionId: string; readonly tokenHash: string; readonly requestId: string }
export interface OidcStartRequest {
  readonly realmId: string; readonly challengeId: string; readonly provider: string; readonly redirectUri: string; readonly stateHash: string; readonly protectedFlow: string;
  readonly peerDigest: string; readonly expiresAt: Date; readonly requestId: string;
}
export interface OidcProviderConfiguration { readonly name: string; readonly issuer: string; readonly clientId: string; readonly clientSecretName: string | null; readonly scopes: readonly string[] }
export interface OidcFlow { readonly challengeId: string; readonly provider: OidcProviderConfiguration; readonly protectedFlow: string; readonly redirectUri: string; readonly scope: EnvironmentScope }
export interface OidcSignIn extends SessionGrant { readonly realmId: string; readonly provider: string; readonly subject: string; readonly email: string }

export interface AppAuthRepository {
  // Developers, through the browser session.
  realm(actor: OrganizationActor, scope: EnvironmentScope): Promise<Realm>;
  executeRealm(input: RealmMutation): Promise<RealmReceipt>;
  users(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string): Promise<readonly AppUser[]>;
  executeUser(input: AppUserMutation): Promise<AppUserReceipt>;
  // The app and its end users.
  configuration(realmId: string): Promise<AppRealmConfiguration>;
  /** The web origins of the realm's allowed redirect URIs. */
  origins(realmId: string): Promise<readonly string[]>;
  /** Never reveals whether the address has an account or a link was sent. */
  requestMagicLink(input: MagicLinkRequest): Promise<void>;
  consumeMagicLink(realmId: string, tokenHash: string, grant: SessionGrant): Promise<AppSession>;
  session(realmId: string, tokenHash: string): Promise<AppSession>;
  rotate(realmId: string, tokenHash: string, nextTokenHash: string, requestId: string): Promise<AppSession>;
  revoke(realmId: string, tokenHash: string, requestId: string): Promise<void>;
  startOidc(input: OidcStartRequest): Promise<OidcProviderConfiguration>;
  takeOidc(realmId: string, stateHash: string): Promise<OidcFlow>;
  signInOidc(input: OidcSignIn): Promise<AppSession>;
}

export interface OidcIdentity { readonly subject: string; readonly email: string }
/** Talks to the customer's identity provider. Implementations must verify the ID token, not just decode it. */
export interface OidcClient {
  authorizationUrl(provider: OidcProviderConfiguration, input: { redirectUri: string; state: string; codeChallenge: string; nonce: string }): Promise<string>;
  exchange(provider: OidcProviderConfiguration, input: { redirectUri: string; code: string; codeVerifier: string; nonce: string; clientSecret?: string }): Promise<OidcIdentity>;
}
/** Reads one environment secret for Cloud's own use (an OIDC client secret). The value never leaves Cloud. */
export interface ProviderSecretReader { read(scope: EnvironmentScope, name: string): Promise<string> }
