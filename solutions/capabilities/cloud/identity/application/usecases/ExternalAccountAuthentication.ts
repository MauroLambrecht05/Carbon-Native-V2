import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { parseComponent, PlatformFault, type GithubAuthStart, type GithubAuthComplete } from "@carbon/contracts/platform";
import type { FreshAuthBinding } from "../../domain/entities/AccountIdentity.ts";
import type { ExternalAccountProvider, ExternalAccountIdentity } from "../ports/ExternalAccountProvider.ts";
import type { ExternalAccountRepository } from "../ports/ExternalAccountRepository.ts";
import type { MessageProtector } from "../ports/AccountNotification.ts";
import { AccountAuthentication, opaqueToken, tokenDigest, tokenMatches } from "./AccountAuthentication.ts";

export class ExternalAccountAuthentication {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: ExternalAccountRepository, private readonly provider: ExternalAccountProvider,
    private readonly protector: MessageProtector, private readonly config: { origin: string; termsVersion: string; rateLimitKey: string }) {}
  private browser(proof: string): string {
    if (!/^browser_[A-Za-z0-9_-]{43}$/.test(proof)) throw new PlatformFault("unauthenticated", "Start GitHub sign-in in this browser first");
    return tokenDigest(proof);
  }
  private async binding(token: string, csrf: string): Promise<FreshAuthBinding> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to link your GitHub account");
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  async start(input: GithubAuthStart, browserProof: string, idempotencyKey: string, requestId: string, peer: string, sessionToken: string, csrf: string) {
    parseComponent("GithubAuthStart", input); parseComponent("CommandOptions", { idempotencyKey }); parseComponent("Id", requestId);
    const browserHash = this.browser(browserProof); const binding = input.purpose === "link" ? await this.binding(sessionToken, csrf) : undefined;
    if (input.purpose === "registration" && (input.termsAccepted !== true || input.termsVersion !== this.config.termsVersion)) throw new PlatformFault("validation", "Accept the current terms to register");
    const redirectPath = input.returnTo ?? (binding ? "/account/security" : "/");
    if (!redirectPath.startsWith("/") || redirectPath.startsWith("//") || /[\\\u0000-\u0020]/.test(redirectPath) || new URL(redirectPath, this.config.origin).origin !== this.config.origin) throw new PlatformFault("validation", "Invalid return path");
    const id = randomUUID(); const state = "gstate_" + randomBytes(32).toString("base64url"); const verifier = randomBytes(32).toString("base64url");
    const hash = (value: string) => createHmac("sha256", this.config.rateLimitKey).update(value).digest("hex");
    const result = await this.repository.start({ id, purpose: input.purpose, stateHash: tokenDigest(state), browserHash,
      protectedStart: await this.protector.seal(JSON.stringify({ state, verifier }), `oauth-start:${id}`), binding, termsVersion: this.config.termsVersion, redirectPath,
      expiresAt: new Date(Date.now() + 10 * 60000), requestId, requestKey: hash(`github:${browserHash}:${idempotencyKey}`),
      requestDigest: tokenDigest(JSON.stringify({ purpose: input.purpose, redirectPath, termsVersion: this.config.termsVersion, binding })),
      rateKeys: [hash(`github:browser:${browserHash}`), hash(`github:peer:${peer}`), ...(binding ? [hash(`github:account:${binding.accountId}`)] : [])] });
    const stored = JSON.parse(await this.protector.open(result.protectedStart, `oauth-start:${result.id}`));
    return parseComponent("GithubAuthStartResponse", { authorizationUrl: this.provider.authorizationUrl(stored.state, createHash("sha256").update(stored.verifier).digest("base64url")) });
  }
  async callback(state: string, code: string | null, browserProof: string) {
    if (!/^gstate_[A-Za-z0-9_-]{43}$/.test(state)) throw new PlatformFault("unauthenticated", "Invalid GitHub sign-in state");
    const browserHash = this.browser(browserProof); const flow = await this.repository.claim(tokenDigest(state), browserHash);
    try {
      if (!code) throw new PlatformFault("unauthenticated", "GitHub authorization was cancelled; start again");
      const start = JSON.parse(await this.protector.open(flow.protectedStart, `oauth-start:${flow.id}`));
      const identity = await this.provider.exchange(code, start.verifier); const token = "go_" + randomBytes(32).toString("base64url");
      await this.repository.ready(flow.id, browserHash, identity, await this.protector.seal(JSON.stringify(identity), `oauth-identity:${flow.id}`), tokenDigest(token));
      return `/auth/github/complete#token=${token}`;
    } catch (error) { await this.repository.fail(flow.id); throw error; }
  }
  async complete(input: GithubAuthComplete, browserProof: string, requestId: string, deviceName: string, sessionToken: string, csrf: string) {
    parseComponent("GithubAuthComplete", input); parseComponent("Id", requestId);
    const browserHash = this.browser(browserProof); const completionHash = tokenDigest(input.token); const proof = await this.repository.proof(completionHash, browserHash);
    const identity = JSON.parse(await this.protector.open(proof.protectedIdentity, `oauth-identity:${proof.id}`)) as ExternalAccountIdentity;
    const actor = proof.purpose === 'link' ? await this.binding(sessionToken, csrf) : undefined;
    const token = opaqueToken("as"); const csrfToken = opaqueToken("csrf");
    const result = await this.repository.complete({ proof, completionHash, browserHash, identity, binding: actor, code: input.code,
      issue: { id: randomUUID(), tokenHash: tokenDigest(token), csrfHash: tokenDigest(csrfToken), expiresAt: new Date(Date.now() + 8 * 3600000), freshUntil: new Date(Date.now() + 10 * 60000),
        deviceName: deviceName.slice(0, 200).replace(/[\u0000-\u001f]/g, ""), requestId } });
    return { ...result, sessionToken: token, csrfToken };
  }
}
