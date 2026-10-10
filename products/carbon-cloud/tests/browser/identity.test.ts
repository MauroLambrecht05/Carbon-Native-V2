import { afterEach, expect, test } from "bun:test";
import { createMockServices, type MockRuntime } from "../../infrastructure/browser/mock/create-mock-services";
import { MemoryPersistence } from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import { unwrap, type Result } from "../../presentation/framework/services/contracts";
import type { AccountCommand, PlatformCommand } from "../../presentation/framework/services/identity-contracts";

const runtimes: MockRuntime[] = [];
afterEach(() => { for (const r of runtimes.splice(0)) r.dispose(); });
async function setup() {
  const persistence = new MemoryPersistence(seedFoundation(1000));
  const runtime = createMockServices({ persistence, wallTime: () => 1000, autoTick: false }); runtimes.push(runtime);
  unwrap(await runtime.tools.setLatency(0));
  return { ...runtime, persistence };
}
function error(result: Result<unknown>, code: string) { expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe(code); }
async function token(r: MockRuntime, purpose: string, email: string) {
  const message = unwrap(await r.tools.inbox()).messages.findLast(m => m.purpose === purpose && m.email === email && m.status === "pending")!;
  expect(message).toBeDefined(); return new URL(message.href, "https://mock.invalid").searchParams.get("token")!;
}
async function accountCommand(r: MockRuntime, input: AccountCommand, key = crypto.randomUUID()) {
  const account = unwrap(await r.services.identity.getAccount());
  return r.services.identity.command(input, { idempotencyKey: key, expectedRevision: account.revision });
}
const orgScope = { orgId: "org_north" };
async function platformCommand(r: MockRuntime, input: PlatformCommand) {
  const org = unwrap(await r.services.catalog.resolveScope({ scope: orgScope }));
  return r.services.platform.command({ scope: orgScope }, input, { idempotencyKey: crypto.randomUUID(), expectedRevision: org.organization.revision });
}
test("registration, one-use verification, MFA recovery and verified identity changes", async () => {
  const r = await setup(), identity = r.services.identity;
  const receipt = unwrap(await identity.request({ purpose: "signup", name: "Casey", email: "casey@example.test", termsAccepted: true, returnTo: "//evil.test" }));
  expect(Object.keys(receipt)).toEqual(["message"]); expect(unwrap(await r.services.session.getSession())).toBeNull();
  const verification = await token(r, "signup", "casey@example.test");
  expect(unwrap(await identity.complete(verification)).returnTo).toBe("/organizations");
  error(await identity.complete(verification), "validation");
  unwrap(await accountCommand(r, { kind: "mfa-start" }));
  const code = unwrap(await r.tools.inbox()).authenticators[0].code;
  const account = unwrap(await identity.getAccount()), options = { expectedRevision: account.revision, idempotencyKey: "enroll" };
  const codes = unwrap(await identity.command({ kind: "mfa-confirm", code }, options)).recoveryCodes!;
  expect(codes.length).toBe(8);
  expect(unwrap(await identity.command({ kind: "mfa-confirm", code }, options)).recoveryCodes).toBeUndefined();
  expect(JSON.stringify(unwrap(await identity.getAccount()))).not.toContain(codes[0]);
  unwrap(await r.services.session.signOut());
  unwrap(await identity.request({ purpose: "signin", email: "casey@example.test" }));
  const signIn = await token(r, "signin", "casey@example.test");
  error(await identity.complete(signIn), "validation"); expect(unwrap(await r.services.session.getSession())).toBeNull();
  unwrap(await identity.complete(signIn, codes[0]));
  unwrap(await accountCommand(r, { kind: "email", email: "verified@example.test" }));
  expect(unwrap(await identity.getAccount()).email).toBe("casey@example.test");
  unwrap(await identity.complete(await token(r, "email", "verified@example.test"), code));
  expect(unwrap(await identity.getAccount()).email).toBe("verified@example.test");
  unwrap(await accountCommand(r, { kind: "link-github", email: "github@example.test" }));
  unwrap(await identity.complete(await token(r, "link-github", "github@example.test"), code));
  unwrap(await accountCommand(r, { kind: "unlink", method: "email" }));
  error(await accountCommand(r, { kind: "unlink", method: "github" }), "conflict");
  unwrap(await r.services.session.signOut());
  unwrap(await identity.request({ purpose: "github", email: "github@example.test" }));
  unwrap(await identity.complete(await token(r, "github", "github@example.test"), code));
  unwrap(await r.services.session.signOut());
  unwrap(await identity.recover("verified@example.test", codes[0]));
  expect(unwrap(await r.services.session.getSession())).toBeNull();
  unwrap(await identity.recover("verified@example.test", codes[1]));
  expect(unwrap(await r.services.session.getSession())?.audience).toBe("dashboard");
});
test("invitation rotation, matching email, scoped grants, revocation and owner protection", async () => {
  const r = await setup(); unwrap(await r.tools.selectIdentity("owner"));
  const invite = unwrap(await platformCommand(r, { kind: "invite", email: "new@example.test", role: "Developer", projects: ["project_north_notes"] }));
  const inbox = unwrap(await r.tools.inbox()).messages.find(m => m.id === invite.resourceId)!;
  const oldToken = inbox.href.split("/").at(-1)!;
  const invitations = unwrap(await r.services.platform.listInvitations({ scope: orgScope }));
  unwrap(await r.services.platform.command({ scope: orgScope }, { kind: "invite-resend", invitationId: invite.resourceId! }, { idempotencyKey: "resend", expectedRevision: invitations.items[0].revision }));
  error(await r.services.platform.previewInvitation(oldToken), "not_found");
  const freshToken = unwrap(await r.tools.inbox()).messages.find(m => m.id === invite.resourceId)!.href.split("/").at(-1)!;
  error(await r.services.platform.respondInvitation(freshToken, true), "forbidden");
  unwrap(await r.tools.selectIdentity("new")); unwrap(await r.services.platform.respondInvitation(freshToken, true));
  error(await r.services.platform.respondInvitation(freshToken, true), "conflict");
  const production = { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_production" };
  expect(unwrap(await r.services.catalog.resolveScope({ scope: production })).permissions["resources.configure"].allowed).toBe(false);
  error(await r.services.catalog.resolveScope({ scope: { orgId: "org_south" } }), "not_found");
  unwrap(await r.tools.selectIdentity("owner"));
  const member = unwrap(await r.services.platform.listMembers({ scope: orgScope })).items.find(m => m.accountId === "new")!;
  unwrap(await r.services.platform.command({ scope: orgScope }, { kind: "member-update", memberId: member.id, role: "Developer", projects: [...member.projects], grants: [{ permission: "resources.configure", scope: production }] }, { idempotencyKey: "grant", expectedRevision: member.revision }));
  const updated = unwrap(await r.services.platform.listMembers({ scope: orgScope })).items.find(m => m.id === member.id)!;
  unwrap(await r.tools.selectIdentity("new"));
  const permissions = unwrap(await r.services.catalog.resolveScope({ scope: production })).permissions;
  expect(permissions["resources.configure"].allowed).toBe(true); expect(permissions["data.read"].allowed).toBe(false);
  unwrap(await r.tools.selectIdentity("owner"));
  unwrap(await r.services.platform.command({ scope: orgScope }, { kind: "member-remove", memberId: member.id }, { idempotencyKey: "remove", expectedRevision: updated.revision }));
  error(await platformCommand(r, { kind: "leave" }), "conflict");
  error(await accountCommand(r, { kind: "delete", confirmation: "owner@example.test" }), "conflict");
  unwrap(await r.tools.selectIdentity("new")); error(await r.services.catalog.resolveScope({ scope: production }), "not_found");
});
test("project creation is idempotent, partial provisioning resumes across reload, production and pause enforce policy", async () => {
  const r = await setup(); unwrap(await r.tools.selectIdentity("owner")); unwrap(await r.tools.failNextProvision());
  const input = { kind: "project-create", name: "New app", slug: "new-app", mode: "data", environment: "development" } as const;
  const options = { idempotencyKey: "create", expectedRevision: "r1" };
  const created = unwrap(await r.services.platform.command({ scope: orgScope }, input, options));
  expect(unwrap(await r.services.platform.command({ scope: orgScope }, input, options)).resourceId).toBe(created.resourceId);
  unwrap(await r.tools.setClock(true, 10_000));
  const operation = unwrap(await r.services.operations.get({ scope: created.operation!.scope }, created.operation!.id));
  expect(operation.state).toBe("failed"); expect(operation.completedSteps).toBe(1);
  const resumed = createMockServices({ persistence: r.persistence, wallTime: () => 1000, autoTick: false }); runtimes.push(resumed);
  unwrap(await resumed.services.operations.retryAllowedStep({ scope: operation.scope }, operation.id, { idempotencyKey: "retry", expectedRevision: operation.revision }));
  unwrap(await resumed.tools.setClock(true, 10_000));
  const resolved = unwrap(await resumed.services.catalog.resolveScope({ scope: operation.scope }));
  expect(resolved.environment?.status).toBe("ready"); expect(resolved.bindings.every(b => b.state === "ready")).toBe(true);
  unwrap(await resumed.services.platform.command({ scope: operation.scope }, { kind: "environment-pause", paused: true, confirmation: resolved.environment!.name }, { idempotencyKey: "pause", expectedRevision: resolved.environment!.revision }));
  const paused = unwrap(await resumed.services.catalog.resolveScope({ scope: operation.scope }));
  expect(paused.permissions["resources.configure"].allowed).toBe(false);
  error(await resumed.services.platform.command({ scope: operation.scope }, { kind: "provision", services: ["database"] }, { idempotencyKey: "denied", expectedRevision: paused.organization.revision }), "forbidden");
  const production = { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_production" };
  const prod = unwrap(await resumed.services.catalog.resolveScope({ scope: production }));
  error(await resumed.services.platform.command({ scope: production }, { kind: "provision", services: ["database"] }, { idempotencyKey: "production", expectedRevision: prod.organization.revision }), "validation");
});
test("fresh ownership acceptance, MFA organization policy and other-session revocation", async () => {
  const r = await setup(); unwrap(await r.tools.selectIdentity("owner"));
  const transfer = unwrap(await platformCommand(r, { kind: "transfer", memberId: "member_developer", previousRole: "Viewer" }));
  unwrap(await r.tools.selectIdentity("developer"));
  unwrap(await r.services.platform.command({ scope: orgScope }, { kind: "transfer-accept", transferId: transfer.resourceId! }, { idempotencyKey: "accept", expectedRevision: "r1" }));
  const members = unwrap(await r.services.platform.listMembers({ scope: orgScope }));
  expect(members.items.find(m => m.accountId === "developer")?.role).toBe("Owner");
  expect(members.items.find(m => m.accountId === "owner")?.role).toBe("Viewer");
  unwrap(await accountCommand(r, { kind: "mfa-start" })); const code = unwrap(await r.tools.inbox()).authenticators.find(a => a.accountId === "developer")!.code;
  unwrap(await accountCommand(r, { kind: "mfa-confirm", code }));
  unwrap(await platformCommand(r, { kind: "organization-policy", requireMfa: true }));
  unwrap(await r.tools.selectIdentity("owner")); error(await r.services.catalog.resolveScope({ scope: orgScope }), "forbidden");
  unwrap(await r.tools.selectIdentity("developer")); error(await r.services.catalog.resolveScope({ scope: orgScope }), "forbidden");
  unwrap(await r.services.identity.request({ purpose: "signin", email: "developer@example.test" }));
  unwrap(await r.services.identity.complete(await token(r, "signin", "developer@example.test"), code));
  unwrap(await r.services.catalog.resolveScope({ scope: orgScope }));
  unwrap(await accountCommand(r, { kind: "revoke-others" }));
  expect(unwrap(await r.services.identity.listSessions({ limit: 100 })).items.filter(s => !s.current).every(s => s.revoked)).toBe(true);
  unwrap(await r.tools.setClock(true, 301_000));
  error(await platformCommand(r, { kind: "organization-policy", requireMfa: false }), "unauthenticated");
});
