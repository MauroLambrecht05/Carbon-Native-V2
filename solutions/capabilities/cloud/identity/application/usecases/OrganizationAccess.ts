import { PlatformFault, parseComponent, type CommandOptions, type OrganizationCommand, type OrganizationCreate, type PageRequest } from "@carbon/contracts/platform";
import type { OrganizationActor, OrganizationRepository } from "../ports/OrganizationRepository.ts";
import type { MessageProtector } from "../ports/AccountNotification.ts";
import { AccountAuthentication, tokenDigest, tokenMatches } from "./AccountAuthentication.ts";

export class OrganizationAccess {
  constructor(private readonly auth: AccountAuthentication, private readonly repository: OrganizationRepository, private readonly protector: MessageProtector) {}

  private async actor(token: string, csrf?: string): Promise<OrganizationActor> {
    const session = await this.auth.session(token);
    if (!session) throw new PlatformFault("unauthenticated", "Sign in to access organizations");
    if (csrf !== undefined && !tokenMatches(csrf, session.csrfHash)) throw new PlatformFault("forbidden", "Invalid CSRF token");
    return { accountId: session.account.id, sessionId: session.id, securityRevision: session.account.securityRevision,
      permissionRevision: session.account.permissionRevision, tokenHash: tokenDigest(token), csrfHash: session.csrfHash };
  }
  async get(token: string, orgId: string) { parseComponent("Id", orgId); return this.repository.get(await this.actor(token), orgId); }

  async memberAccess(token: string, orgId: string, membershipId: string) {
    parseComponent("Id", orgId); parseComponent("Id", membershipId);
    return this.repository.memberAccess(await this.actor(token), orgId, membershipId);
  }

  async list(token: string, input: PageRequest, orgId?: string) {
    const query = parseComponent("PageRequest", input);
    if ((query.sort && query.sort !== "id") || query.filter) throw new PlatformFault("validation", "Only ID ordering without filters is supported");
    if (orgId) parseComponent("Id", orgId);
    const actor = await this.actor(token); const limit = query.limit ?? 25;
    const organization = orgId ? (await this.repository.get(actor, orgId)).organization : undefined;
    const context = `organizations:${actor.sessionId}:${actor.permissionRevision}:${orgId ?? "all"}:${organization?.revision ?? ""}:${limit}`;
    let afterId: string | undefined;
    if (query.cursor) {
      try {
        const cursor = JSON.parse(await this.protector.open(query.cursor, context));
        afterId = parseComponent("Id", cursor.afterId);
        if (!Number.isSafeInteger(cursor.expiresAt) || cursor.expiresAt <= Date.now()) throw new Error("Expired cursor");
      } catch { throw new PlatformFault("validation", "The cursor is invalid or expired; restart the list"); }
    }
    const rows = orgId ? await this.repository.members(actor, orgId, organization!.revision, limit + 1, afterId) : await this.repository.list(actor, limit + 1, afterId);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? await this.protector.seal(JSON.stringify({ afterId: items.at(-1)!.id, expiresAt: Date.now() + 15 * 60000 }), context) : null;
    return orgId ? parseComponent("OrganizationMembersPage", { items, nextCursor, revision: organization!.revision }) : parseComponent("OrganizationPage", { items, nextCursor });
  }
  async create(token: string, csrf: string, input: OrganizationCreate, options: CommandOptions, requestId: string) {
    parseComponent("OrganizationCreate", input);
    return this.mutate(token, csrf, { kind: "create", ...input }, options, requestId);
  }
  async command(token: string, csrf: string, orgId: string, input: OrganizationCommand, options: CommandOptions, requestId: string) {
    parseComponent("OrganizationCommand", input); parseComponent("Id", orgId);
    if (!options.expectedRevision) throw new PlatformFault("validation", "The current organization revision is required");
    return this.mutate(token, csrf, input, options, requestId, orgId);
  }
  private async mutate(token: string, csrf: string, input: OrganizationCommand | (OrganizationCreate & { kind: "create" }), options: CommandOptions, requestId: string, orgId?: string) {
    parseComponent("CommandOptions", options); parseComponent("Id", requestId);
    let command = input;
    if (input.kind === "member-access") {
      const keys = new Set<string>();
      for (const grant of input.grants) {
        if (grant.scope.orgId !== orgId) throw new PlatformFault("validation", "Grant organization must match the request");
        if (grant.scope.realmId) throw new PlatformFault("capability", "Realm grants are not configured");
        const key = `${grant.permission}:${grant.scope.projectId ?? ''}:${grant.scope.environmentId ?? ''}`;
        if (keys.has(key)) throw new PlatformFault("validation", "A permission may occur only once per scope");
        keys.add(key);
      }
      command = { ...input, projectIds: [...input.projectIds].sort(), grants: input.grants.map(grant => ({ permission: grant.permission,
        scope: { orgId: grant.scope.orgId, ...(grant.scope.projectId ? { projectId: grant.scope.projectId } : {}), ...(grant.scope.environmentId ? { environmentId: grant.scope.environmentId } : {}) },
        ...(grant.expiresAt ? { expiresAt: new Date(grant.expiresAt).toISOString() } : {}) })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
    }
    if (input.kind === "create" || input.kind === "update") {
      const name = input.name.trim();
      if (!name || /[\u0000-\u001f\u007f]/.test(name)) throw new PlatformFault("validation", "Enter an organization name without control characters");
      command = { ...input, name };
    }
    return this.repository.execute({ actor: await this.actor(token, csrf), orgId, command, expectedRevision: options.expectedRevision,
      keyDigest: tokenDigest(options.idempotencyKey), requestDigest: tokenDigest(JSON.stringify({ command, revision: options.expectedRevision, orgId })), requestId });
  }
}
