import type { AppAuthService, AppUser, AppUserQuery, Realm } from "../../../presentation/framework/services/app-auth-contracts";
import type { RequestContext } from "../../../presentation/framework/services/contracts";
import type { RowValues } from "../../../presentation/framework/services/data-contracts";
import { Refusal, requireSession } from "./access";
import { now } from "./clock";
import { configurationState } from "./configuration-state";
import { actor, checkRevision, dataAudit, environmentAccess, jsonObject, once, production, tableFor, timestamp, type Run } from "./data-common";
import { applyRows, rowsPage, selectRows, startJob } from "./data-engine";
import { dataState } from "./data-state";
import { allocate, bump } from "./identity-state";
import { paginate } from "./pagination";
import type { MockState } from "./store";

const normalizeEmail = (email: string) => { const value = email.trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) throw new Refusal("validation", "Enter a valid email address."); return value; };
const safeProfile = (values: RowValues) => { jsonObject(values, "Profile metadata"); if (Object.keys(values).some(k => ["role", "roles", "claims", "admin", "permissions", "__proto__", "constructor"].includes(k))) throw new Refusal("validation", "Privileged fields belong in server-controlled claims, not the user-editable profile."); };
function realmFor(state: MockState, realmId: string) {
  const realm = dataState(state).realms[realmId];
  if (!realm || !Object.values(state.bindings).some(b => b.scope.environmentId === realm.scope.environmentId && b.owner === "auth" && b.state === "ready")) throw new Refusal("not_found", "Application realm not found or not provisioned.");
  const env = state.environments[realm.scope.environmentId!];
  if (env.status === "paused" || state.projects[env.projectId].status === "archived") throw new Refusal("forbidden", "This application environment is paused or archived.");
  return realm;
}
function userFor(state: MockState, realm: Realm, id: string) { const user = dataState(state).users[id]; if (!user || user.realmId !== realm.id) throw new Refusal("not_found", "App user not found."); return user; }
function liveSession(state: MockState, realm: Realm, wall: number) {
  const data = dataState(state), id = data.activeSessions[realm.id], session = id ? data.sessions[id] : undefined, user = session && data.users[session.userId];
  if (!session || session.realmId !== realm.id || session.audience !== "app" || session.revoked || Date.parse(session.expiresAt) <= now(state.clock, wall) || user?.status !== "active" || !user.verified) return null;
  return { session, user };
}
function authEvent(state: MockState, realm: Realm, kind: string, provider: string, reason: string, outcome: "succeeded" | "failed", requestId: string, wall: number, userId?: string) {
  const id = allocate(state, "app_event"); dataState(state).authEvents[id] = { id, realmId: realm.id, kind, provider, reason, outcome, correlationId: requestId, createdAt: timestamp(state, wall), userId };
  dataAudit(state, realm.scope, userId ?? "app-client", `app-auth.${kind}.${outcome}`, realm.id, requestId, wall, outcome);
}
function issueSession(state: MockState, realm: Realm, user: AppUser, wall: number) {
  const data = dataState(state), previous = data.activeSessions[realm.id]; if (previous && data.sessions[previous]) { data.sessions[previous].revoked = true; data.sessions[previous].revision = bump(data.sessions[previous].revision); }
  const id = allocate(state, "app_session"); data.sessions[id] = { id, realmId: realm.id, userId: user.id, projectId: realm.scope.projectId!, environmentId: realm.scope.environmentId!, audience: "app", createdAt: timestamp(state, wall), expiresAt: new Date(now(state.clock, wall) + realm.sessionMinutes * 60_000).toISOString(), revoked: false, revision: "r1" }; data.activeSessions[realm.id] = id; return data.sessions[id];
}
function revokeUser(state: MockState, user: AppUser) { const data = dataState(state); for (const session of Object.values(data.sessions).filter(s => s.userId === user.id && !s.revoked)) { session.revoked = true; session.revision = bump(session.revision); } for (const challenge of Object.values(data.challenges).filter(c => c.realmId === user.realmId && c.email === user.email)) challenge.consumed = true; }
function renderEmail(realm: Realm, email: string, link: string, expires: string) { const variables: Record<string, string> = { app: realm.scope.projectId!, email, link, expires }; const render = (value: string) => value.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) => variables[key] ?? ""); return { subject: render(realm.template.subject), body: render(realm.template.body) }; }
function challenge(state: MockState, realm: Realm, email: string, provider: "email" | "oauth", redirect: string, wall: number) {
  const data = dataState(state), id = `mock_app_proof_${crypto.randomUUID()}`, expiresAt = new Date(now(state.clock, wall) + 600_000).toISOString();
  const href = `/app-auth/${encodeURIComponent(realm.id)}/callback?challenge=${encodeURIComponent(id)}`;
  const message = renderEmail(realm, email, href, expiresAt);
  data.challenges[id] = { id, realmId: realm.id, email, provider, redirect, expiresAt, consumed: false, ...message }; return href;
}
export function createAppAuthServices(run: Run, wallTime: () => number): AppAuthService {
  const admin = (state: MockState, context: RequestContext, permission: "metadata.read" | "data.read" | "data.write" | "resources.configure") => { environmentAccess(state, context, permission, wallTime(), "auth"); return realmFor(state, `realm_${context.scope.environmentId}`); };
  const userDto = (state: MockState, user: AppUser): AppUser => ({ ...user, sessionCount: Object.values(dataState(state).sessions).filter(s => s.userId === user.id && !s.revoked && Date.parse(s.expiresAt) > now(state.clock, wallTime())).length });
  const users = (state: MockState, realm: Realm, query: AppUserQuery = {}) => { if (query.since && !Number.isFinite(Date.parse(query.since))) throw new Refusal("validation", "Invalid created-since date."); return Object.values(dataState(state).users).filter(u => u.realmId === realm.id && (!query.email || u.email.includes(query.email.toLowerCase())) && (!query.userId || u.id.includes(query.userId)) && (!query.status || u.status === query.status) && (!query.provider || u.providers.includes(query.provider)) && (!query.since || Date.parse(u.createdAt) >= Date.parse(query.since))).map(u => userDto(state, u)); };
  return {
    getRealm: context => run(state => admin(state, context, "metadata.read"), { signal: context.signal }),
    configureRealm: (context, input, confirmation, options) => run((state, requestId) => {
      const realm = admin(state, context, "resources.configure"); production(state, context.scope, confirmation, wallTime());
      if (input.invalidateSessions) admin(state, context, "data.write");
      return once(state, context.scope, actor(state, wallTime()), "realm.configure", [input, confirmation], options, () => {
        checkRevision(realm.revision, options);
        if ([input.signup, input.magicLink, input.invalidateSessions, input.oauth.enabled].some(value => typeof value !== "boolean")) throw new Refusal("validation", "Provider, signup and session choices must be explicit booleans.");
        if (!Number.isInteger(input.sessionMinutes) || input.sessionMinutes < 5 || input.sessionMinutes > 43_200) throw new Refusal("validation", "Session TTL must be 5–43,200 minutes (mock policy).");
        if (!Array.isArray(input.redirects) || !input.redirects.length || input.redirects.length > 20) throw new Refusal("validation", "Set 1–20 exact redirect URLs.");
        for (const redirect of input.redirects) { try { const url = new URL(redirect); if (url.username || url.password || url.hash || redirect.includes("*") || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw Error(); } catch { throw new Refusal("validation", "Redirects must be exact HTTPS URLs or localhost HTTP URLs without wildcards, credentials or fragments."); } }
        normalizeEmail(input.sender); if (!["unconfigured", "verified", "failed"].includes(input.delivery)) throw new Refusal("validation", "Unsupported delivery state.");
        if (input.magicLink && input.delivery !== "verified") throw new Refusal("validation", "Magic links require verified mock delivery settings. Disable the method while simulating delivery failure.");
        for (const text of [input.template.subject, input.template.body]) { if (!text.trim() || text.length > 10_000 || [...text.matchAll(/{{(.*?)}}/g)].some(m => !["app", "email", "link", "expires"].includes(m[1].trim()))) throw new Refusal("validation", "Email templates support only {{app}}, {{email}}, {{link}}, {{expires}} within 10 KB."); }
        if (!input.template.body.includes("{{link}}")) throw new Refusal("validation", "Email body must contain {{link}}.");
        if (!["deny", "verified-email"].includes(input.oauth.linking)) throw new Refusal("validation", "Unsupported identity linking policy.");
        if (input.oauth.enabled) { if (!input.oauth.clientId.trim() || input.oauth.callback !== `/app-auth/${realm.id}/callback`) throw new Refusal("validation", "OAuth needs a client ID and this realm's exact hosted callback."); const secret = configurationState(state).secrets[input.oauth.secretId]; if (!secret || secret.scope.environmentId !== context.scope.environmentId || secret.scope.projectId !== context.scope.projectId) throw new Refusal("not_found", "OAuth secret reference not found in this environment."); }
        const config = configurationState(state), binding = `App OAuth:${realm.id}`;
        for (const secret of Object.values(config.secrets)) if (secret.bindings.includes(binding)) Object.assign(secret, { bindings: secret.bindings.filter(b => b !== binding) });
        if (input.oauth.enabled) { const secret = config.secrets[input.oauth.secretId]; Object.assign(secret, { bindings: [...secret.bindings, binding] }); }
        const { invalidateSessions } = input; Object.assign(realm, structuredClone({ signup: input.signup, magicLink: input.magicLink, redirects: input.redirects, sessionMinutes: input.sessionMinutes, delivery: input.delivery, sender: input.sender, template: { subject: input.template.subject, body: input.template.body }, oauth: { enabled: input.oauth.enabled, clientId: input.oauth.clientId, secretId: input.oauth.secretId, callback: input.oauth.callback, linking: input.oauth.linking } }), { revision: bump(realm.revision) });
        if (invalidateSessions) for (const user of users(state, realm)) revokeUser(state, user);
        dataAudit(state, context.scope, actor(state, wallTime()), "realm.configured", realm.id, requestId, wallTime()); return { message: `Realm configuration saved. ${invalidateSessions ? "Existing sessions and pending challenges revoked." : "Existing sessions retain their original expiry; new sessions use the new TTL."}`, resourceId: realm.id };
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: "realm.configure.refused" } }),
    listUsers: (context, query) => run((state, requestId) => { const realm = admin(state, context, "data.read"); dataAudit(state, context.scope, actor(state, wallTime()), "app-users.read", realm.id, requestId, wallTime()); return paginate(users(state, realm, query), query, `${requireSession(state, wallTime()).visibilityKey}:${realm.id}:${JSON.stringify(query ? { ...query, cursor: undefined } : {})}`); }, { signal: context.signal, mutate: true, quiet: true }),
    getUser: (context, id) => run((state, requestId) => { const realm = admin(state, context, "data.read"), user = userFor(state, realm, id); const data = dataState(state); const ownedRows = Object.values(data.rows).filter(r => { const table = data.tables[r.tableId]; return table?.scope.environmentId === context.scope.environmentId && table.policies.some(p => p.kind === "owner" && r.values[p.ownerColumn!] === id); }).length; dataAudit(state, context.scope, actor(state, wallTime()), "app-user.read", id, requestId, wallTime()); return { user: userDto(state, user), sessions: Object.values(data.sessions).filter(s => s.userId === id), ownedRows, retention: "Deletion retains user ID, tombstone and authentication history; profile/email/claims are removed from the identity record. Historical inbox and export snapshots are retained until local workspace reset. Owned rows remain orphaned. Blob ownership/retention arrives in Slice 6. There is no implicit cascading deletion." }; }, { signal: context.signal, mutate: true, quiet: true }),
    userCommand: (context, command, confirmation, options) => run((state, requestId) => {
      if (!["create", "invite", "metadata", "suspend", "resume", "revoke-sessions", "revoke-session", "delete"].includes(command.kind)) throw new Refusal("unsupported_operation", "Unknown app-user command."); const realm = admin(state, context, "data.write"); production(state, context.scope, confirmation, wallTime());
      return once(state, context.scope, actor(state, wallTime()), `app-user.${command.kind}`, [command, confirmation], options, () => {
        const data = dataState(state); let id: string;
        if (command.kind === "create" || command.kind === "invite") {
          const email = normalizeEmail(command.email); if (Object.values(data.users).some(u => u.realmId === realm.id && u.email === email && u.status !== "deleted")) throw new Refusal("conflict", "This email already has a user in the selected realm.");
          if (command.kind === "invite" && (!realm.magicLink || realm.delivery !== "verified")) throw new Refusal("validation", "Invitations require enabled magic links and verified mock delivery.");
          id = crypto.randomUUID(); data.users[id] = { id, realmId: realm.id, email, status: command.active ? "active" : "pending", verified: false, providers: [], profile: {}, claims: {}, createdAt: timestamp(state, wallTime()), revision: "r1", sessionCount: 0 };
          if (command.kind === "invite") { challenge(state, realm, email, "email", realm.redirects[0], wallTime()); authEvent(state, realm, "invitation", "email", "Fake invitation delivered to the realm inbox.", "succeeded", requestId, wallTime(), id); }
        } else {
          const user = userFor(state, realm, command.userId); id = user.id; checkRevision(user.revision, options);
          if (user.status === "deleted") throw new Refusal("conflict", "Deleted identities cannot be changed or resurrected.");
          if (command.kind === "metadata") { safeProfile(command.profile); jsonObject(command.claims, "Server-controlled claims"); user.profile = structuredClone(command.profile); user.claims = structuredClone(command.claims); }
          if (command.kind === "suspend") { user.status = "suspended"; revokeUser(state, user); }
          if (command.kind === "resume") { if (user.status !== "suspended") throw new Refusal("conflict", "Only suspended users can resume."); user.status = user.verified ? "active" : "pending"; }
          if (command.kind === "revoke-sessions") revokeUser(state, user);
          if (command.kind === "revoke-session") { const session = data.sessions[command.sessionId]; if (!session || session.userId !== id || session.realmId !== realm.id) throw new Refusal("not_found", "App session not found."); session.revoked = true; session.revision = bump(session.revision); }
          if (command.kind === "delete") { if (command.confirmation !== id || command.orphanPolicy !== "retain") throw new Refusal("validation", "Type the user ID and explicitly retain orphaned data."); revokeUser(state, user); Object.assign(user, { status: "deleted", email: "", profile: {}, claims: {}, verified: false, providers: [] }); }
          user.revision = bump(user.revision);
        }
        dataAudit(state, context.scope, actor(state, wallTime()), `app-user.${command.kind}`, id, requestId, wallTime()); return { message: "App user change committed. New identities remain unverified until proof is consumed; revoked sessions stay revoked.", resourceId: id };
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: `app-user.${command.kind}.refused` } }),
    exportUsers: (context, query, fields, options) => run((state, requestId) => { const realm = admin(state, context, "data.read"); if (!fields.length || fields.some(f => !["id", "email", "status", "verified", "providers", "createdAt", "profile", "claims"].includes(f))) throw new Refusal("validation", "Choose supported export fields. Sessions, passwords, proofs and credentials cannot be exported."); return once(state, context.scope, actor(state, wallTime()), "app-users.export", [query, fields], options, () => { const rows = users(state, realm, query).map(user => Object.fromEntries(fields.map(field => [field, (user as unknown as RowValues)[field]]))); const operationId = startJob(state, context.scope, requireSession(state, wallTime()).id, { permission: "data.read", payload: { kind: "export", rows, filename: `${realm.id}-users.json` } }, requestId, wallTime()); dataAudit(state, context.scope, actor(state, wallTime()), "app-users.export.queued", realm.id, requestId, wallTime()); return { message: `${rows.length} users captured for permissioned export.`, operationId }; }); }, { signal: context.signal, mutate: true }),
    events: (context, page) => run(state => { const realm = admin(state, context, "metadata.read"); return paginate(Object.values(dataState(state).authEvents).filter(e => e.realmId === realm.id && (!page?.userId || e.userId === page.userId) && (!page?.provider || e.provider === page.provider) && (!page?.outcome || e.outcome === page.outcome)), page, `${actor(state, wallTime())}:${realm.id}:${page?.provider}:${page?.outcome}:${page?.userId}:events`); }, { signal: context.signal }),
    inbox: (context, page) => run(state => { const realm = admin(state, context, "data.read"); return paginate(Object.values(dataState(state).challenges).filter(c => c.realmId === realm.id).map(c => ({ id: c.id, email: c.email, subject: c.subject, body: c.body, expiresAt: c.expiresAt, consumed: c.consumed, href: `/app-auth/${encodeURIComponent(realm.id)}/callback?challenge=${encodeURIComponent(c.id)}` })), page, `${requireSession(state, wallTime()).visibilityKey}:${realm.id}:inbox`); }, { signal: context.signal }),
    previewEmail: (context, email) => run(state => { const realm = admin(state, context, "resources.configure"); return renderEmail(realm, normalizeEmail(email), "[one-time local link]", "[ten-minute expiry]"); }, { signal: context.signal }),
    publicRealm: realmId => run(state => { const realm = realmFor(state, realmId); return { id: realm.id, signup: realm.signup, magicLink: realm.magicLink, oauth: realm.oauth.enabled, redirects: realm.redirects, passwordReason: realm.password.reason }; }),
    requestChallenge: (realmId, input, options) => run((state, requestId) => {
      const realm = realmFor(state, realmId), email = normalizeEmail(input.email);
      return once(state, realm.scope, `app-request:${email}`, "app.challenge", input, options, () => {
        if (input.outcome && !["success", "denied", "error"].includes(input.outcome)) throw new Refusal("validation", "Unsupported provider outcome."); if (!realm.redirects.includes(input.redirect)) throw new Refusal("validation", "Redirect URL is not in this realm's exact allowlist.");
        let failure: string | undefined;
        if (input.provider === "email") { if (realm.delivery === "failed") failure = "Simulated email delivery failure."; else if (!realm.magicLink || realm.delivery !== "verified") failure = "Email provider disabled or delivery unavailable."; }
        else if (input.provider === "oauth") { if (!realm.oauth.enabled) failure = "OAuth provider disabled."; else if (input.outcome === "denied" || input.outcome === "error") failure = input.outcome === "denied" ? "Mock OAuth consent denied." : "Mock OAuth provider error."; }
        else throw new Refusal("validation", "Unsupported sign-in provider.");
        const user = Object.values(dataState(state).users).find(u => u.realmId === realm.id && u.email === email && u.status !== "deleted");
        if (user?.status === "suspended") failure = "Identity suspended.";
        if (!user && !realm.signup) failure = "Signup disabled for unknown identity.";
        if (input.provider === "oauth" && user && !user.providers.includes("oauth") && !(realm.oauth.linking === "verified-email" && user.verified)) failure = "Explicit verified-email linking policy is required for an existing identity.";
        if (failure) { authEvent(state, realm, "sign-in", input.provider, failure, "failed", requestId, wallTime(), user?.id); return { message: "No session created. Inspect authorized auth event history for the simulated failure reason." }; }
        challenge(state, realm, email, input.provider, input.redirect, wallTime()); authEvent(state, realm, "delivery", input.provider, "One-time proof delivered to local realm inbox; no external provider contacted.", "succeeded", requestId, wallTime(), user?.id); return { message: "If this identity is eligible, a one-time proof is in the authorized realm mock inbox. No email was sent." };
      });
    }, { mutate: true }),
    consumeChallenge: (realmId, challengeId) => run((state, requestId) => {
      const realm = realmFor(state, realmId), data = dataState(state), proof = data.challenges[challengeId];
      if (!proof || proof.realmId !== realm.id || proof.consumed || Date.parse(proof.expiresAt) <= now(state.clock, wallTime())) { authEvent(state, realm, "callback", "unknown", "Wrong, expired or previously consumed proof.", "failed", requestId, wallTime()); return { redirect: "", error: "Wrong, expired or previously consumed proof." }; }
      let user = Object.values(data.users).find(u => u.realmId === realm.id && u.email === proof.email && u.status !== "deleted");
      if (!realm.redirects.includes(proof.redirect) || (proof.provider === "email" ? !realm.magicLink || realm.delivery !== "verified" : !realm.oauth.enabled) || user?.status === "suspended" || (!user && !realm.signup) || (proof.provider === "oauth" && user && !user.providers.includes("oauth") && !(realm.oauth.linking === "verified-email" && user.verified))) { proof.consumed = true; authEvent(state, realm, "callback", proof.provider, "Current realm/identity policy denied callback.", "failed", requestId, wallTime()); return { redirect: "", error: "Current realm/identity policy denied callback." }; }
      proof.consumed = true;
      if (!user) { const id = crypto.randomUUID(); user = { id, realmId, email: proof.email, status: "active", verified: true, providers: [], profile: {}, claims: {}, createdAt: timestamp(state, wallTime()), revision: "r1", sessionCount: 0 }; data.users[id] = user; }
      user.verified = true; user.status = "active"; user.providers = [...new Set([...user.providers, proof.provider])]; user.revision = bump(user.revision); issueSession(state, realm, user, wallTime()); authEvent(state, realm, "callback", proof.provider, "Proof consumed once; realm session issued.", "succeeded", requestId, wallTime(), user.id); return { redirect: proof.redirect };
    }, { mutate: true }).then(result => result.ok && "error" in result.value ? { ok: false as const, error: { code: "forbidden" as const, message: String(result.value.error), requestId: "mock-app-callback" } } : result),
    currentSession: realmId => run(state => { const realm = realmFor(state, realmId), live = liveSession(state, realm, wallTime()); return live ? { session: live.session, user: { id: live.user.id, email: live.user.email, profile: live.user.profile } } : null; }),
    sessionCommand: (realmId, command, profile) => run((state, requestId) => { const realm = realmFor(state, realmId), live = liveSession(state, realm, wallTime()); if (!live) throw new Refusal("unauthenticated", "No active app session in this realm."); if (command === "signout") { live.session.revoked = true; live.session.revision = bump(live.session.revision); delete dataState(state).activeSessions[realmId]; } else if (command === "rotate") issueSession(state, realm, live.user, wallTime()); else if (command === "profile") { safeProfile(profile ?? {}); live.user.profile = structuredClone(profile ?? {}); live.user.revision = bump(live.user.revision); } else throw new Refusal("validation", "Unknown app session action."); authEvent(state, realm, command, "session", "App client change committed.", "succeeded", requestId, wallTime(), live.user.id); return { message: "App session change committed. Carbon account session is separate." }; }, { mutate: true }),
    clientTables: realmId => run(state => { const realm = realmFor(state, realmId); if (!Object.values(state.bindings).some(b => b.scope.environmentId === realm.scope.environmentId && b.owner === "database" && b.state === "ready")) throw new Refusal("unsupported_operation", "Database resources are not ready."); return Object.values(dataState(state).tables).filter(t => t.scope.environmentId === realm.scope.environmentId).map(t => ({ id: t.id, name: t.name })); }),
    queryRows: (realmId, tableId, query) => run(state => { const realm = realmFor(state, realmId), live = liveSession(state, realm, wallTime()), table = tableFor(state, realm.scope, tableId); if (dataState(state).activeSessions[realmId] && !live) throw new Refusal("unauthenticated", "The app session is expired, revoked or suspended; authenticate again."); const access = { mode: "policy-preview" as const, userId: live?.user.id }; return rowsPage(selectRows(state, table, query, access), query, `${realmId}:${live?.session.id ?? "anonymous"}:${table.revision}`); }),
    rowCommand: (realmId, tableId, command, options) => run((state, requestId) => { const realm = realmFor(state, realmId), live = liveSession(state, realm, wallTime()); if (!live) throw new Refusal("unauthenticated", "Verified realm session required for writes."); const table = tableFor(state, realm.scope, tableId); return once(state, realm.scope, live.session.id, `app.rows.${tableId}.${command.kind}`, command, options, () => { const id = applyRows(state, table, command, { mode: "policy-preview", userId: live.user.id }, options, wallTime()); dataAudit(state, realm.scope, live.user.id, `app.rows.${command.kind}`, tableId, requestId, wallTime()); return { message: "Policy-authorized app row transaction committed.", resourceId: id }; }); }, { mutate: true }),
  };
}
