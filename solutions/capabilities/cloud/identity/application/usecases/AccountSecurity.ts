import { randomBytes, randomUUID } from "node:crypto";
import { PlatformFault, parseComponent, type AccountSecurityCommand, type CommandOptions, type PageRequest } from "@carbon/contracts/platform";
import type { AccountSecurityRepository } from "../ports/AccountSecurityRepository.ts";
import type { MessageProtector } from "../ports/AccountNotification.ts";
import type { TotpVerifier } from "../ports/TotpVerifier.ts";
import { AccountAuthentication, opaqueToken, tokenDigest, tokenMatches } from "./AccountAuthentication.ts";

export class AccountSecurity {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: AccountSecurityRepository, private readonly protector: MessageProtector, private readonly totp: TotpVerifier) {}

  async listIdentities(token: string) {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to view linked identities");
    return parseComponent("AccountIdentities", { items: await this.repository.listIdentities(tokenDigest(token), session.account.revision), revision: session.account.revision });
  }

  async listSessions(token: string, input: PageRequest) {
    const query = parseComponent("PageRequest", input);
    if ((query.sort && query.sort !== "id") || query.filter) throw new PlatformFault("validation", "Sessions support only ID ordering and no filters");
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to view sessions");
    const limit = query.limit ?? 25;
    const context = `account-sessions:${session.id}:${session.account.revision}:${limit}`;
    let afterId: string | undefined;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(await this.protector.open(query.cursor, context));
        afterId = parseComponent("Id", cursor.afterId);
        if (!Number.isSafeInteger(cursor.expiresAt) || cursor.expiresAt <= Date.now()) throw new Error("Expired cursor");
      } catch { throw new PlatformFault("validation", "Session cursor is invalid or expired; restart the list"); }
    }
    const rows = await this.repository.listSessions(tokenDigest(token), session.account.revision, limit + 1, afterId);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? await this.protector.seal(JSON.stringify({ afterId: items.at(-1)!.id, expiresAt: Date.now() + 15 * 60000 }), context) : null;
    return parseComponent("AccountSessionsPage", { items, nextCursor, revision: session.account.revision });
  }

  async execute(token: string, csrf: string, input: AccountSecurityCommand, options: CommandOptions, requestId: string) {
    const command = parseComponent("AccountSecurityCommand", input);
    parseComponent("CommandOptions", options); parseComponent("Id", requestId);
    if (!options.expectedRevision) throw new PlatformFault("validation", "The current account revision is required");
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to manage account security");
    if (!tokenMatches(csrf, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
    const factorId = randomUUID();
    const secret = command.kind === "mfa-start" ? this.totp.generateSecret() : undefined;
    const codes = ["mfa-confirm", "recovery-reset"].includes(command.kind) ? Array.from({ length: 10 }, () => `cr_${randomBytes(16).toString("base64url")}`) : [];
    const sessionToken = opaqueToken("as"); const csrfToken = opaqueToken("csrf");
    const result = await this.repository.execute({
      tokenHash: tokenDigest(token), csrfHash: tokenDigest(csrf), requestId,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ command, revision: options.expectedRevision })),
      expectedRevision: options.expectedRevision, command,
      enrollment: secret ? { id: factorId, protectedSecret: await this.protector.seal(secret, `mfa:${factorId}`) } : undefined,
      recoveryHashes: codes.map(tokenDigest),
      rotation: { id: randomUUID(), tokenHash: tokenDigest(sessionToken), csrfHash: tokenDigest(csrfToken), deviceName: session.deviceName, expiresAt: new Date(session.expiresAt), freshUntil: new Date(session.freshUntil), requestId },
    });
    const enrollment = result.disclose && secret ? {
      factorId, secret,
      uri: `otpauth://totp/${encodeURIComponent(`Carbon:${session.account.email}`)}?secret=${secret}&issuer=Carbon&algorithm=SHA1&digits=6&period=30`,
    } : undefined;
    return { receipt: result.receipt, enrollment, recoveryCodes: result.disclose && codes.length ? codes : undefined,
      rotatedSession: result.rotated ? { token: sessionToken, csrfToken, expiresAt: result.expiresAt! } : undefined };
  }
}
