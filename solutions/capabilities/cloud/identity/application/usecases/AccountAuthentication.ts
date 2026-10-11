import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { PlatformFault, parseComponent, type AccountAuthRequest, type AccountFreshAuthRequest } from "@carbon/contracts/platform";
import type { FreshAuthBinding } from "../../domain/entities/AccountIdentity.ts";
import type { AccountIdentityRepository } from "../ports/AccountIdentityRepository.ts";
import type { MessageProtector } from "../ports/AccountNotification.ts";

const RECEIPT = { message: "If this address can be used, an email with the next step will arrive shortly." } as const;
export function opaqueToken(prefix: "ac" | "ec" | "inv" | "as" | "csrf" | "browser" | "ce" | "dv" | "dc" | "cs"): string { return `${prefix}_${randomBytes(32).toString("base64url")}`; }
export function tokenDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function tokenMatches(value: string, digest: string): boolean {
  const actual = Buffer.from(tokenDigest(value), "hex"); const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export type ChallengeRequest = AccountAuthRequest;

export class AccountAuthentication {
  constructor(
    private readonly accounts: AccountIdentityRepository,
    private readonly protector: MessageProtector,
    private readonly config: { origin: string; termsVersion: string; rateLimitKey: string },
    private readonly now = () => new Date(),
  ) {
    const origin = new URL(config.origin);
    if (origin.origin !== config.origin || (origin.protocol !== "https:" && !["http://localhost", "http://127.0.0.1"].some(prefix => config.origin === prefix || config.origin.startsWith(prefix + ":")))) throw new Error("Account origin must be an HTTPS origin or explicit loopback HTTP origin");
    if (config.rateLimitKey.length < 32 || !config.termsVersion) throw new Error("Account security configuration is incomplete");
  }

  configuration() { return { termsVersion: this.config.termsVersion, emailAvailable: true, sessionTtlSeconds: 8 * 3600 }; }

  async request(input: ChallengeRequest, browserProof: string, idempotencyKey: string, requestId: string, peerAddress: string): Promise<typeof RECEIPT> {
    return this.requestChallenge(input, browserProof, idempotencyKey, requestId, peerAddress);
  }

  async requestFresh(token: string, csrf: string, input: AccountFreshAuthRequest, browserProof: string, idempotencyKey: string, requestId: string, peerAddress: string) {
    parseComponent("AccountFreshAuthRequest", input);
    const session = await this.requireSession(token, csrf);
    return this.requestChallenge({ email: session.account.email, name: session.account.name, purpose: "login", returnTo: input.returnTo ?? "/account/security" },
      browserProof, idempotencyKey, requestId, peerAddress,
      { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision, tokenHash: tokenDigest(token), csrfHash: tokenDigest(csrf) },
      new Date(session.expiresAt));
  }

  private async requestChallenge(input: ChallengeRequest, browserProof: string, idempotencyKey: string, requestId: string, peerAddress: string, freshAuth?: FreshAuthBinding, sessionExpiresAt?: Date): Promise<typeof RECEIPT> {
    parseComponent("AccountAuthRequest", input);
    parseComponent("CommandOptions", { idempotencyKey }); parseComponent("Id", requestId);
    if (!/^browser_[A-Za-z0-9_-]{43}$/.test(browserProof)) throw new PlatformFault("unauthenticated", "Start sign-in in this browser first");
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (email.length > 254 || !/^[^\s@<>\u0000-\u001f]+@[^\s@<>\u0000-\u001f]+\.[^\s@<>\u0000-\u001f]+$/.test(email)) throw new PlatformFault("validation", "Enter a valid email address");
    if (!["registration", "login", "recovery"].includes(input.purpose)) throw new PlatformFault("validation", "Invalid sign-in purpose");
    if (input.purpose === "registration" && (input.termsAccepted !== true || input.termsVersion !== this.config.termsVersion)) throw new PlatformFault("validation", "Accept the current terms to register");
    const name = input.name?.trim() || email.split("@")[0]!;
    if (Array.from(name).length > 100 || /[\u0000-\u001f]/.test(name)) throw new PlatformFault("validation", "Enter a name of at most 100 characters");
    const redirectPath = input.returnTo ?? "/";
    if (redirectPath.length > 2048 || !redirectPath.startsWith("/") || redirectPath.startsWith("//") || /[\\\u0000-\u0020]/.test(redirectPath) || new URL(redirectPath, this.config.origin).origin !== this.config.origin) throw new PlatformFault("validation", "Invalid return path");
    const id = randomUUID(); const token = opaqueToken("ac");
    const browserHash = tokenDigest(browserProof);
    const digest = (value: string) => createHmac("sha256", this.config.rateLimitKey).update(value).digest("hex");
    const purpose = freshAuth ? "fresh_auth" : input.purpose;
    const completionPath = freshAuth ? "/auth/fresh" : "/auth/complete";
    const message = {
      to: email, subject: "Continue to Carbon",
      text: `Continue to Carbon in the browser where you requested this email:\n\n${this.config.origin}${completionPath}#token=${token}\n\nThis link expires in 15 minutes${freshAuth ? " or when your current session ends" : ""} and can be used once. If you did not request it, ignore this email.`,
    };
    await this.accounts.queueChallenge({
      id, email, name, purpose, tokenHash: tokenDigest(token), browserHash, freshAuth,
      termsVersion: this.config.termsVersion, redirectPath, expiresAt: new Date(Math.min(this.now().getTime() + 15 * 60000, sessionExpiresAt?.getTime() ?? Infinity)),
      requestKey: digest(`challenge:${email}:${freshAuth ? `fresh:${freshAuth.sessionId}:` : ""}${idempotencyKey}`),
      requestDigest: tokenDigest(JSON.stringify({ email, name, purpose, redirectPath, browserHash, termsVersion: this.config.termsVersion,
        ...(freshAuth ? { sessionId: freshAuth.sessionId, securityRevision: freshAuth.securityRevision } : {}) })),
      requestId, rateKeys: [digest(`email:${email}`), digest(`peer:${peerAddress}`)],
      protectedMessage: await this.protector.seal(JSON.stringify(message), id),
    });
    return RECEIPT;
  }

  async complete(token: string, browserProof: string, requestId: string, deviceName: string, code?: string) {
    return this.exchange(token, browserProof, requestId, deviceName, code);
  }

  async completeFresh(sessionToken: string, csrf: string, token: string, browserProof: string, requestId: string, code?: string) {
    const session = await this.requireSession(sessionToken, csrf);
    return this.exchange(token, browserProof, requestId, session.deviceName, code,
      { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision, tokenHash: tokenDigest(sessionToken), csrfHash: tokenDigest(csrf) });
  }

  private async exchange(token: string, browserProof: string, requestId: string, deviceName: string, code?: string, freshAuth?: FreshAuthBinding) {
    if (!/^ac_[A-Za-z0-9_-]{43}$/.test(token) || !/^browser_[A-Za-z0-9_-]{43}$/.test(browserProof)) throw new PlatformFault("unauthenticated", "The sign-in link is invalid or expired");
    parseComponent("Id", requestId);
    const sessionToken = opaqueToken("as"); const csrfToken = opaqueToken("csrf");
    const current = this.now();
    const result = await this.accounts.consumeChallenge(tokenDigest(token), tokenDigest(browserProof), {
      id: randomUUID(), tokenHash: tokenDigest(sessionToken), csrfHash: tokenDigest(csrfToken),
      expiresAt: new Date(current.getTime() + 8 * 3600000), freshUntil: new Date(current.getTime() + 10 * 60000),
      deviceName: deviceName.slice(0, 200).replace(/[\u0000-\u001f]/g, ""), requestId,
    }, code, freshAuth);
    return { ...result, sessionToken, csrfToken };
  }

  async session(token: string) {
    if (!/^as_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.accounts.findSession(tokenDigest(token));
  }

  /** The account a device (`dc_`) or personal (`pt_`) credential acts for, or null when the token is not a usable one. */
  async delegation(token: string) {
    const kind = /^dc_[A-Za-z0-9_-]{43}$/.test(token) ? 'device' as const : /^pt_[A-Za-z0-9_-]{43}$/.test(token) ? 'personal' as const : null;
    if (!kind) return null;
    const found = await this.accounts.findDelegation(kind, tokenDigest(token));
    return found ? { ...found, kind } : null;
  }

  private async requireSession(token: string, csrf: string) {
    const session = await this.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to authenticate this session");
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
    return session;
  }

  async signOut(token: string, csrfToken: string, requestId: string): Promise<void> {
    parseComponent("Id", requestId);
    const session = await this.session(token);
    if (!session) return;
    if (!tokenMatches(csrfToken, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
    await this.accounts.revokeSession(tokenDigest(token), tokenDigest(csrfToken), requestId);
  }
}
