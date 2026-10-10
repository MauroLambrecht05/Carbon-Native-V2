import { createHmac, randomUUID } from "node:crypto";
import { PlatformFault, parseComponent, type CommandOptions, type InvitationCommand, type InvitationProof, type PageRequest } from "@carbon/contracts/platform";
import type { OrganizationActor, OrganizationRepository } from "../ports/OrganizationRepository.ts";
import type { OrganizationInvitationsRepository } from "../ports/OrganizationInvitationsRepository.ts";
import type { MessageProtector } from "../ports/AccountNotification.ts";
import { AccountAuthentication, opaqueToken, tokenDigest, tokenMatches } from "./AccountAuthentication.ts";

export class OrganizationInvitations {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: OrganizationInvitationsRepository,
    private readonly organizations: OrganizationRepository, private readonly protector: MessageProtector,
    private readonly config: { origin: string; rateLimitKey: string }) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to access invitations");
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
    return { accountId: session.account.id, sessionId: session.id, tokenHash: tokenDigest(token), csrfHash: session.csrfHash,
      securityRevision: session.account.securityRevision, permissionRevision: session.account.permissionRevision };
  }
  async list(token: string, orgId: string, input: PageRequest) {
    parseComponent("Id", orgId); const query = parseComponent("PageRequest", input);
    if ((query.sort && query.sort !== "id") || query.filter) throw new PlatformFault("validation", "Only ID ordering without filters is supported");
    const actor = await this.actor(token); const { organization } = await this.organizations.get(actor, orgId); const limit = query.limit ?? 25;
    const context = `invitations:${actor.sessionId}:${actor.permissionRevision}:${orgId}:${organization.revision}:${limit}`;
    let afterId: string | undefined;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(await this.protector.open(query.cursor, context)); afterId = parseComponent("Id", cursor.afterId);
        if (!Number.isSafeInteger(cursor.expiresAt) || cursor.expiresAt <= Date.now()) throw new Error("Expired cursor");
      } catch { throw new PlatformFault("validation", "The cursor is invalid or expired; restart the list"); }
    }
    const rows = await this.repository.list(actor, orgId, organization.revision, limit + 1, afterId); const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? await this.protector.seal(JSON.stringify({ afterId: items.at(-1)!.id, expiresAt: Date.now() + 15 * 60000 }), context) : null;
    return parseComponent("InvitationsPage", { items, nextCursor, revision: organization.revision });
  }
  async command(token: string, csrf: string, orgId: string, input: InvitationCommand, options: CommandOptions, requestId: string, peerAddress: string) {
    parseComponent("Id", orgId); parseComponent("Id", requestId); parseComponent("InvitationCommand", input); parseComponent("CommandOptions", options);
    if (!options.expectedRevision) throw new PlatformFault("validation", "The current organization revision is required");
    const actor = await this.actor(token, csrf); let command = input; let delivery;
    if (input.kind !== "cancel") {
      const email = input.kind === "create" ? input.email.trim().toLowerCase() : await this.repository.destination(actor, orgId, input.invitationId);
      if (!/^[^\s@<>\u0000-\u001f]+@[^\s@<>\u0000-\u001f]+\.[^\s@<>\u0000-\u001f]+$/.test(email)) throw new PlatformFault("validation", "Enter a valid email address");
      if (input.kind === "create") command = { ...input, email };
      const { organization } = await this.organizations.get(actor, orgId); const id = randomUUID(); const proof = opaqueToken("inv");
      const message = { to: email, subject: "Your Carbon organization invitation",
        text: `You are invited to join ${organization.name} on Carbon. Sign in with this verified email address to review and accept:\n\n${this.config.origin}/invitations/accept#token=${proof}\n\nThis invitation expires in 7 days. If you did not expect it, you can ignore this message.` };
      const hash = (value: string) => createHmac("sha256", this.config.rateLimitKey).update(value).digest("hex");
      delivery = { id, tokenHash: tokenDigest(proof), protectedMessage: await this.protector.seal(JSON.stringify(message), id), expiresAt: new Date(Date.now() + 7 * 86400000),
        rateKeys: [hash(`invitation:org:${orgId}`), hash(`invitation:email:${email}`), hash(`invitation:actor:${actor.accountId}`), hash(`invitation:peer:${peerAddress}`)] };
    }
    return this.repository.execute({ actor, orgId, command, delivery, expectedRevision: options.expectedRevision, keyDigest: tokenDigest(options.idempotencyKey),
      requestDigest: tokenDigest(JSON.stringify({ command, orgId, revision: options.expectedRevision })), requestId });
  }
  async preview(token: string, csrf: string, input: InvitationProof) {
    parseComponent("InvitationProof", input); return this.repository.preview(await this.actor(token, csrf), tokenDigest(input.token));
  }
  async accept(token: string, csrf: string, input: InvitationProof, options: CommandOptions, requestId: string) {
    parseComponent("InvitationProof", input); parseComponent("CommandOptions", options); parseComponent("Id", requestId);
    if (options.expectedRevision !== undefined) throw new PlatformFault("validation", "Invitation acceptance does not accept a revision");
    const hash = tokenDigest(input.token);
    return this.repository.accept({ actor: await this.actor(token, csrf), tokenHash: hash, keyDigest: tokenDigest(options.idempotencyKey),
      requestDigest: tokenDigest(`invitation-accept:${hash}`), requestId });
  }
}
