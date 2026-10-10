import { createHmac, randomUUID } from "node:crypto";
import { parseComponent, PlatformFault, type AccountEmailComplete, type AccountProfileCommand, type CommandOptions } from "@carbon/contracts/platform";
import type { AccountProfileRepository } from "../ports/AccountProfileRepository.ts";
import type { MessageProtector } from "../ports/AccountNotification.ts";
import { AccountAuthentication, opaqueToken, tokenDigest, tokenMatches } from "./AccountAuthentication.ts";

export class AccountProfile {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: AccountProfileRepository,
    private readonly protector: MessageProtector, private readonly config: { origin: string; rateLimitKey: string }) {}

  async view(token: string) {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to view the account");
    const pendingEmailChange = await this.repository.pendingEmail({ accountId: session.account.id, sessionId: session.id,
      securityRevision: session.account.securityRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash }, session.account.revision);
    return parseComponent("AccountProfileView", { account: session.account, pendingEmailChange });
  }

  private async actor(token: string, csrf: string) {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to manage this account");
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
    return { session, binding: { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      tokenHash: tokenDigest(token), csrfHash: tokenDigest(csrf) } };
  }

  async execute(token: string, csrf: string, input: AccountProfileCommand, options: CommandOptions, requestId: string, browserProof: string, peerAddress: string) {
    parseComponent("AccountProfileCommand", input); parseComponent("CommandOptions", options); parseComponent("Id", requestId);
    if (!options.expectedRevision) throw new PlatformFault("validation", "The current account revision is required");
    const { session, binding } = await this.actor(token, csrf);
    let command = input;
    if (input.kind === "update") {
      const name = input.name.trim();
      if (!name || /[\u0000-\u001f\u007f]/.test(name + input.avatar)) throw new PlatformFault("validation", "Enter a display name and local text avatar without control characters");
      command = { ...input, name };
    }
    let emailChange;
    if (input.kind === "email-change") {
      const email = input.email.trim().toLowerCase();
      if (!/^[^\s@<>\u0000-\u001f]+@[^\s@<>\u0000-\u001f]+\.[^\s@<>\u0000-\u001f]+$/.test(email)) throw new PlatformFault("validation", "Enter a valid email address");
      if (email === session.account.email) throw new PlatformFault("validation", "Choose a different email address");
      if (!/^browser_[A-Za-z0-9_-]{43}$/.test(browserProof)) throw new PlatformFault("unauthenticated", "Start verification in this browser first");
      command = { kind: "email-change", email };
      const id = randomUUID(); const proof = opaqueToken("ec");
      const message = { to: email, subject: "Verify your new Carbon email",
        text: `Verify this address in the browser where you requested the change:\n\n${this.config.origin}/account/email/verify#token=${proof}\n\nThis link expires in 15 minutes or when your current session ends. Your existing sign-in email stays active until verification succeeds.` };
      const hash = (value: string) => createHmac("sha256", this.config.rateLimitKey).update(value).digest("hex");
      emailChange = { id, tokenHash: tokenDigest(proof), browserHash: tokenDigest(browserProof),
        expiresAt: new Date(Math.min(Date.now() + 15 * 60000, new Date(session.expiresAt).getTime())),
        protectedMessage: await this.protector.seal(JSON.stringify(message), id),
        rateKeys: [hash(`email:${email}`), hash(`email:${session.account.email}`), hash(`peer:${peerAddress}`)] };
    }
    return this.repository.execute({ binding, command, emailChange, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ namespace: "account-profile", command,
        revision: options.expectedRevision, ...(emailChange ? { browserHash: emailChange.browserHash } : {}) })), requestId });
  }

  async completeEmail(token: string, csrf: string, input: AccountEmailComplete, browserProof: string, requestId: string) {
    parseComponent("AccountEmailComplete", input); parseComponent("Id", requestId);
    if (!/^browser_[A-Za-z0-9_-]{43}$/.test(browserProof)) throw new PlatformFault("unauthenticated", "The verification link is invalid or expired");
    const { session, binding } = await this.actor(token, csrf);
    const sessionToken = opaqueToken("as"); const csrfToken = opaqueToken("csrf"); const noticeId = randomUUID();
    const notice = { to: session.account.email, subject: "Your Carbon sign-in email changed",
      text: `Your Carbon account's sign-in email has changed. If you did not authorize this change, contact Carbon support or your organization owner.\n\n${this.config.origin}/account/security` };
    const result = await this.repository.completeEmail({ binding, previousEmail: session.account.email, tokenHash: tokenDigest(input.token),
      browserHash: tokenDigest(browserProof), code: input.code,
      issue: { id: randomUUID(), tokenHash: tokenDigest(sessionToken), csrfHash: tokenDigest(csrfToken), deviceName: session.deviceName,
        expiresAt: new Date(session.expiresAt), freshUntil: new Date(Date.now() + 10 * 60000), requestId },
      notice: { id: noticeId, protectedMessage: await this.protector.seal(JSON.stringify(notice), noticeId) } });
    return { ...result, sessionToken, csrfToken };
  }
}
