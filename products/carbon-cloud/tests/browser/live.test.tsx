import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../../presentation/App";
import { ServicesContext } from "../../presentation/framework/services/context";
import { RuntimeContext } from "../../presentation/framework/services/runtime";
import { SessionProvider } from "../../presentation/framework/session/SessionProvider";
import { createLiveServices } from "../../infrastructure/browser/http/live-services";
import { LiveTransport } from "../../infrastructure/browser/http/transport";
import { createFrontendRoutes } from "../../infrastructure/http/frontend-routes";

const product = resolve(import.meta.dir, "../..");
beforeAll(() => notifyManager.setNotifyFunction((callback) => act(callback)));
afterAll(() => notifyManager.setNotifyFunction((callback) => callback()));
let view: ReactTestRenderer | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

/** A stand-in for the network: answers by path, and records what was asked. */
function network(answers: Record<string, (init: RequestInit) => Response | Promise<Response>>) {
  const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = String(input); calls.push({ path, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(answers).find(candidate => path === candidate || path.split("?")[0] === candidate);
    return key ? answers[key]!(init) : Response.json({ error: { code: "not_found", message: "Not found", requestId: "r-1" } }, { status: 404, headers: { "x-request-id": "r-1" } });
  }) as typeof fetch;
  return { send, calls };
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { "x-request-id": "request-1", ...headers } });

test("the production composition reaches no mock, no development tool and no server code", () => {
  const forbidden = /carbon-cloud\/(infrastructure\/browser\/mock\/|presentation\/devtools\/|infrastructure\/(http|persistence|notifications)\/|composition\/(entrypoint|worker|create-browser-services|browser\.tsx))|\/solutions\//;
  const seen = new Set<string>(); const pending = [join(product, "composition", "browser.live.tsx")];
  const locate = (from: string, specifier: string) => [specifier, `${specifier}.ts`, `${specifier}.tsx`, join(specifier, "index.ts")].map(candidate => resolve(dirname(from), candidate)).find(candidate => existsSync(candidate) && !candidate.endsWith(dirname(candidate)));
  while (pending.length) {
    const file = pending.pop()!; if (seen.has(file)) continue; seen.add(file);
    // Every import and re-export that survives compilation. Type-only ones are erased and do not ship.
    for (const match of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']|^\s*import\s+["'](\.[^"']+)["']/gm)) {
      const target = locate(file, match[1] ?? match[2]!); expect([file, match[1] ?? match[2], !!target]).toEqual([file, match[1] ?? match[2], true]); pending.push(target!);
    }
  }
  const modules = [...seen].map(file => file.replaceAll("\\", "/"));
  expect(modules.filter(path => forbidden.test(path))).toEqual([]);
  // It is the whole application, not a stub: the pages and the live adapters are in it.
  for (const expected of ["presentation/App.tsx", "presentation/features/identity/IdentityPages.tsx", "infrastructure/browser/http/live-services.ts", "infrastructure/browser/http/transport.ts"]) expect(modules.some(path => path.endsWith(expected))).toBe(true);
  expect(modules.length).toBeGreaterThan(30);
  // The same walk does find the mock from the mock composition, so the check above is not vacuous.
  expect(readFileSync(join(product, "composition", "browser.tsx"), "utf8")).toContain("infrastructure/browser/mock/");

  const html = readFileSync(join(product, "presentation", "index.live.html"), "utf8");
  expect(html).toContain("connect-src 'self'"); expect(html).toContain('src="/composition/browser.live.tsx"'); expect(html.toLowerCase()).not.toContain("mock");
  // The build itself enforces the same rule.
  expect(readFileSync(join(product, "composition", "vite.live.config.ts"), "utf8")).toContain("must not ship reached the production browser bundle");
});

test("every request carries its credentials the same way, and every failure becomes a service error", async () => {
  const net = network({
    "/platform/v1/ok": () => json({ value: 1 }),
    "/platform/v1/denied": () => json({ error: { code: "forbidden", message: "No.", requestId: "r-9" } }, 403),
    "/platform/v1/off": () => json({ error: { code: "capability", message: "Not configured" } }, 501),
    "/platform/v1/full": () => json({ error: { code: "quota", message: "Over" } }, 429),
    "/platform/v1/slow": () => json({ error: { code: "rate_limited", message: "Wait" } }, 429, { "retry-after": "900" }),
    "/platform/v1/broken": () => json({ error: { code: "internal", message: "Oops" } }, 500),
    "/platform/v1/fields": () => json({ error: { code: "validation", message: "Bad", fieldErrors: { slug: "taken", nested: { no: 1 } } } }, 400),
    "/platform/v1/gone": () => json({ error: { code: "unauthenticated", message: "Sign in" } }, 401),
    "/platform/v1/html": () => new Response("<html>bad gateway</html>", { status: 502 }),
    "/platform/v1/empty": () => new Response("not json", { status: 200 }),
    "/platform/v1/down": () => { throw new TypeError("fetch failed"); },
    "/platform/v1/aborted": () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
  });
  const http = new LiveTransport({ fetch: net.send, cookies: () => "theme=dark; __Host-carbon-csrf=csrf-token-value; other=1" });
  expect(await http.get("/platform/v1/ok")).toEqual({ ok: true, value: { value: 1 } });
  // A read sends no CSRF token and no body. A command sends the token the page can read, its key and the revision it saw.
  expect([...net.calls[0]!.headers.keys()].sort()).toEqual(["accept"]); expect(net.calls[0]!.body).toBeUndefined();
  await http.post("/platform/v1/ok", { a: 1 }, { idempotencyKey: "key-1", expectedRevision: "7" });
  expect(Object.fromEntries(net.calls[1]!.headers)).toEqual({ accept: "application/json", "content-type": "application/json", "x-csrf-token": "csrf-token-value", "idempotency-key": "key-1", "if-match": "7" }); expect(net.calls[1]!.body).toEqual({ a: 1 });
  await http.post("/platform/v1/ok", undefined); expect(net.calls[2]!.headers.has("idempotency-key")).toBe(false); expect(net.calls[2]!.body).toEqual({});
  expect(new LiveTransport({ fetch: net.send, cookies: () => "carbon-csrf=plain" })).toBeDefined();

  const code = async (path: string) => { const result = await http.get(path); return result.ok ? "ok" : result.error.code; };
  expect(await http.get("/platform/v1/denied")).toEqual({ ok: false, error: { code: "forbidden", message: "No.", requestId: "r-9" } });
  // The server's names are translated to the ones pages know.
  expect(await code("/platform/v1/off")).toBe("unsupported_operation"); expect(await code("/platform/v1/full")).toBe("quota_exceeded"); expect(await code("/platform/v1/broken")).toBe("unavailable");
  expect(await http.get("/platform/v1/slow")).toMatchObject({ error: { code: "rate_limited", retryAfterMs: 900000 } });
  // Only text field errors are passed on.
  expect(await http.get("/platform/v1/fields")).toMatchObject({ error: { code: "validation", fieldErrors: { slug: "taken" } } }); expect(((await http.get("/platform/v1/fields")) as { error: { fieldErrors: object } }).error.fieldErrors).toEqual({ slug: "taken" });
  // Whatever goes wrong below the API is one of the same errors, never an exception and never a raw response.
  expect(await code("/platform/v1/html")).toBe("unavailable"); expect(await code("/platform/v1/empty")).toBe("unavailable"); expect(await code("/platform/v1/down")).toBe("unavailable"); expect(await code("/platform/v1/aborted")).toBe("cancelled");
  expect(await code("/platform/v1/unknown")).toBe("not_found");
  // The page is told when the server no longer knows the session.
  let told = 0; const stop = http.onUnauthenticated(() => { told++; }); expect(await code("/platform/v1/gone")).toBe("unauthenticated"); expect(told).toBe(1); stop(); await code("/platform/v1/gone"); expect(told).toBe(1);
});

test("areas that are not connected answer so without touching the network, and session changes reach the page", async () => {
  const session = { id: "s-1", expiresAt: "2026-10-12T00:00:00Z", account: { id: "a-1", name: "Ada", securityRevision: "3", permissionRevision: "5" } };
  let signedIn = true;
  const net = network({
    "/platform/v1/account/session": () => json({ session: signedIn ? session : null }),
    "/platform/v1/auth/complete": () => json({ returnTo: "/organizations" }),
    "/platform/v1/auth/signout": () => { signedIn = false; return json({ signedOut: true }); },
    "/platform/v1/orgs": () => (signedIn ? json({ items: [{ id: "o-1", name: "North", revision: "2" }, { id: "o-2", name: "South", revision: "1" }], nextCursor: "next" }) : json({ error: { code: "unauthenticated", message: "Sign in" } }, 401)),
  });
  const { services } = createLiveServices({ fetch: net.send, cookies: () => "" });
  // Not connected: an honest answer, with nothing sent anywhere and nothing made up.
  for (const call of [services.delivery.listBuilds?.({ scope: { orgId: "o-1" } } as never), (services.billing as any).getSummary?.({ scope: { orgId: "o-1" } }), (services.registry as any).search?.(), services.identity.request({ email: "a@example.test", purpose: "github" }),
    services.identity.recover("a@example.test", "code"), services.identity.listNotifications(), services.platform.respondInvitation("inv", false), services.events.subscribe({ scope: { orgId: "o-1" } }, undefined, () => {})]) {
    expect(await call).toMatchObject({ ok: false, error: { code: "unsupported_operation" } });
  }
  expect(net.calls).toEqual([]);
  expect(await services.platform.command(undefined, { kind: "leave" }, { idempotencyKey: "k" })).toMatchObject({ ok: false, error: { code: "validation" } });

  const changes: boolean[] = []; const stop = services.session.subscribe(change => { changes.push(change.security); });
  // The visibility key changes with anything that changes what the session may see.
  expect(await services.session.getSession()).toEqual({ ok: true, value: { id: "s-1", accountId: "a-1", name: "Ada", audience: "dashboard", expiresAt: session.expiresAt, visibilityKey: "s-1.3.5" } });
  expect(await services.identity.complete("ac_token", "123456")).toEqual({ ok: true, value: { returnTo: "/organizations" } }); expect(net.calls.at(-1)!.body).toEqual({ token: "ac_token", code: "123456" }); expect(changes).toEqual([true]);
  // A name filter is applied to the page that came back; the cursor is passed through untouched.
  await services.session.getSession();
  expect(await services.catalog.listOrganizations({ limit: 2, cursor: "c 1", filter: { name: "nor" }, sort: "name" })).toEqual({ ok: true, value: { items: [{ id: "o-1", name: "North", revision: "2" }], nextCursor: "next", total: 1 } });
  expect(net.calls.at(-1)!.path).toBe("/platform/v1/orgs?limit=2&cursor=c+1");
  // The session ends on the server: the next answer says so, and the page is told once to drop what it shows.
  signedIn = false; expect(await services.catalog.listOrganizations()).toMatchObject({ ok: false, error: { code: "unauthenticated" } }); expect(changes).toEqual([true, true]);
  await services.catalog.listOrganizations(); expect(changes).toEqual([true, true]);
  signedIn = true; await services.session.getSession(); expect((await services.session.signOut()).ok).toBe(true); expect(changes).toEqual([true, true, true]);
  stop(); await services.identity.complete("ac_token"); expect(changes).toHaveLength(3);
});

async function mount(path: string, send: typeof fetch) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const { services } = createLiveServices({ fetch: send, cookies: () => "__Host-carbon-csrf=t" });
  await act(async () => {
    view = create(<QueryClientProvider client={cache}><RuntimeContext.Provider value={{ live: true }}><ServicesContext.Provider value={services}><SessionProvider><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></SessionProvider></ServicesContext.Provider></RuntimeContext.Provider></QueryClientProvider>);
  });
  for (let attempt = 0; attempt < 40; attempt++) { await act(async () => { await new Promise(done => setTimeout(done, 15)); }); const shown = JSON.stringify(view!.toJSON()); if (!cache.isFetching() && !shown.includes("Resolving ") && !shown.includes("Loading ")) break; }
  return JSON.stringify(view!.toJSON());
}

test("against the live service the console says only true things: no mock wording, no page for an area that is not connected", async () => {
  const session = { id: "s-1", expiresAt: "2026-10-12T00:00:00Z", account: { id: "a-1", name: "Ada", securityRevision: "1", permissionRevision: "1" } };
  const visitor = network({ "/platform/v1/account/session": () => json({ session: null }) });
  for (const path of ["/sign-in", "/sign-up", "/auth/recovery", "/auth/complete"]) {
    const page = await mount(path, visitor.send); view!.unmount(); view = undefined;
    expect(page.toLowerCase()).not.toContain("mock"); expect(page.toLowerCase()).not.toContain("simulated"); expect(page.toLowerCase()).not.toContain("fake");
    expect(page).toContain(path === "/auth/complete" ? "Complete sign-in" : path === "/sign-up" ? "Create your Carbon account" : path === "/auth/recovery" ? "Recover your Carbon account" : "Sign in to Carbon");
    // GitHub and recovery-by-code are not connected, so their forms are not offered.
    expect(page).not.toContain("GitHub"); expect(page).not.toContain("support case");
  }
  // A visitor on a protected page is sent to sign in.
  expect(await mount("/organizations", visitor.send)).toContain("Sign in to Carbon"); view!.unmount(); view = undefined;

  const member = network({
    "/platform/v1/account/session": () => json({ session }),
    "/platform/v1/orgs": () => json({ items: [{ id: "11111111-1111-4111-8111-111111111111", name: "North Works", revision: "2" }], nextCursor: null }),
  });
  const organizations = await mount("/organizations", member.send); view!.unmount(); view = undefined;
  expect(organizations).toContain("North Works"); expect(organizations).toContain("Ada"); expect(organizations.toLowerCase()).not.toContain("mock"); expect(organizations).not.toContain("Operations");
  // Routes of areas that are not connected: a notice, and not one request for their data.
  for (const path of ["/orgs/11111111-1111-4111-8111-111111111111/billing", "/orgs/11111111-1111-4111-8111-111111111111/projects/22222222-2222-4222-8222-222222222222/builds", "/registry", "/operations", "/account/tokens"]) {
    member.calls.length = 0; const page = await mount(path, member.send); view!.unmount(); view = undefined;
    expect(page).toContain("not connected to Carbon Cloud"); expect(page.toLowerCase()).not.toContain("mock");
    expect(member.calls.map(call => call.path)).toEqual(["/platform/v1/account/session"]);
  }
  expect(await mount("/no/such/route", member.send)).toContain("Not found"); view!.unmount(); view = undefined;

  // The links Carbon emails carry their token in the fragment, which no server ever sees. The page reads it from there.
  const link = network({ "/platform/v1/account/session": () => json({ session: null }), "/platform/v1/auth/complete": () => json({ returnTo: "/organizations" }),
    "/platform/v1/invitations/preview": () => json({ id: "v-1", orgId: "o-1", organizationName: "North Works", role: "Viewer", requireMfa: false, expiresAt: "2026-10-18T00:00:00Z" }) });
  const token = `ac_${"B".repeat(43)}`; await mount(`/auth/complete#token=${token}`, link.send);
  await act(async () => { await view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  expect(link.calls.find(call => call.path === "/platform/v1/auth/complete")!.body).toEqual({ token }); expect(link.calls.every(call => !call.path.includes(token))).toBe(true); view!.unmount(); view = undefined;
  const invitation = `inv_${"C".repeat(43)}`; const invited = await mount(`/invitations/accept#token=${invitation}`, link.send);
  expect(invited).toContain("North Works"); expect(link.calls.find(call => call.path === "/platform/v1/invitations/preview")!.body).toEqual({ token: invitation });
});

test("every connected page renders from live answers, with the names the server gave and no mock wording", async () => {
  const [org, projectId, environmentId] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const account = { id: "a-1", name: "Ada", email: "ada@example.test", avatar: "AD", verifiedAt: "2026-10-01T00:00:00Z", termsVersion: "2026-09", securityRevision: "1", permissionRevision: "1", revision: "4", mfa: false };
  const permissions = ["organization.manage", "members.manage", "projects.create", "metadata.read", "resources.configure", "audit.read"];
  const net = network({
    "/platform/v1/account/session": () => json({ session: { id: "s-1", expiresAt: "2026-10-12T00:00:00Z", account } }),
    "/platform/v1/account/profile": () => json({ account, pendingEmailChange: null }),
    "/platform/v1/account/identities": () => json({ items: [{ id: "i-1", provider: "email", subject: "ada@example.test", verifiedAt: "2026-10-01T00:00:00Z", canUnlink: false }], revision: "4" }),
    "/platform/v1/account/sessions": () => json({ items: [{ id: "s-1", createdAt: "2026-10-11T00:00:00Z", expiresAt: "2026-10-12T00:00:00Z", deviceName: "Firefox on Windows", current: true, mfaVerified: false }], nextCursor: null, revision: "4" }),
    [`/platform/v1/orgs/${org}`]: () => json({ organization: { id: org, name: "North Works", slug: "north-works", state: "active", revision: "6", role: "Owner", membershipId: "m-1", membershipRevision: "1", requireMfa: false }, transfer: null }),
    [`/platform/v1/orgs/${org}/access`]: () => json({ scope: { orgId: org }, permissions, permissionRevision: "1", membershipRevision: "1", organizationRevision: "6" }),
    [`/platform/v1/orgs/${org}/projects`]: () => json({ items: [{ id: projectId, orgId: org, name: "Notes", slug: "notes", state: "active", revision: "2", productionMutationsAllowed: true, createdAt: "2026-10-02T00:00:00Z" }], nextCursor: null, revision: "6" }),
    [`/platform/v1/orgs/${org}/projects/${projectId}`]: () => json({ id: projectId, orgId: org, name: "Notes", slug: "notes", state: "active", revision: "2", productionMutationsAllowed: true, createdAt: "2026-10-02T00:00:00Z" }),
    [`/platform/v1/orgs/${org}/projects/${projectId}/environments`]: () => json({ items: [{ id: environmentId, orgId: org, projectId, name: "Development", kind: "development", state: "active", revision: "3", provisioning: "ready", createdAt: "2026-10-02T00:00:00Z" }], nextCursor: null, revision: "2" }),
    [`/platform/v1/orgs/${org}/projects/${projectId}/environments/${environmentId}`]: () => json({ environment: { id: environmentId, orgId: org, projectId, name: "Development", kind: "development", state: "active", revision: "3", provisioning: "ready", createdAt: "2026-10-02T00:00:00Z" },
      bindings: [{ id: "b-1", scope: { orgId: org, projectId, environmentId }, owner: "database", state: "ready", desiredState: "active", remoteResourceId: "env_abc", operationId: "op-1", revision: "1" }] }),
    [`/platform/v1/orgs/${org}/members`]: () => json({ items: [{ id: "m-1", accountId: "a-1", name: "Ada", email: "ada@example.test", role: "Owner", revision: "1" }], nextCursor: null, revision: "6" }),
    [`/platform/v1/orgs/${org}/invitations`]: () => json({ items: [{ id: "v-1", email: "grace@example.test", role: "Developer", state: "pending", revision: "1", invitedBy: "a-1", expiresAt: "2026-10-18T00:00:00Z" }], nextCursor: null, revision: "6" }),
    [`/platform/v1/orgs/${org}/audit`]: () => json({ items: [{ id: "e-1", sequence: "9", scope: { orgId: org }, action: "organization.created", resource: { owner: "cloud", kind: "organization", id: org }, actor: { kind: "account", id: "a-1" }, occurredAt: "2026-10-01T00:00:00Z", requestId: "r-1" }], nextCursor: null }),
  });
  const pages: [string, string[]][] = [
    ["/account/profile", ["ada@example.test", "Save profile", "Verify new email"]], ["/account/sessions", ["Current session", "s-1"]], ["/account/security", ["Sign-in methods: ", "email"]],
    [`/orgs/${org}/overview`, ["North Works", "Notes", "Create project", "organization.created"]], [`/orgs/${org}/members`, ["ada@example.test", "Owner", "grace@example.test"]], [`/orgs/${org}/settings`, ["north-works", "Save organization"]],
    [`/orgs/${org}/projects/${projectId}/overview`, ["Notes", "Development", "Create environment"]], [`/orgs/${org}/projects/${projectId}/environments/${environmentId}/overview`, ["Development", "database", "env_abc", "Pause environment"]],
  ];
  for (const [path, expected] of pages) {
    const page = await mount(path, net.send); view!.unmount(); view = undefined;
    for (const text of expected) expect([path, text, page.includes(text)]).toEqual([path, text, true]);
    for (const word of ["mock", "fake", "simulated", "fixture", "slice "]) expect([path, word, page.toLowerCase().includes(word)]).toEqual([path, word, false]);
    // Nothing on a connected page asked for something the live service does not offer.
    expect([path, page.includes("not connected to the live service")]).toEqual([path, false]);
  }
  // Every request went to the API under the page's own origin, and nowhere else.
  expect(net.calls.every(call => call.path.startsWith("/platform/v1/"))).toBe(true);
});

test("the functions pages show what the service holds and send its own commands: deploy, invoke, cancel, and schedules by calendar or interval", async () => {
  const [org, projectId, environmentId, functionId, executionId, scheduleId] = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
  const scope = { orgId: org, projectId, environmentId }; const env = `/platform/v1/orgs/${org}/projects/${projectId}/environments/${environmentId}`; const pages = `/orgs/${org}/projects/${projectId}/environments/${environmentId}/functions`;
  const fn = { id: functionId, scope, name: "report", state: "active", activeRevision: 2, latestRevision: 3, revision: "5", createdAt: "2026-10-02T00:00:00Z" };
  const execution = (overrides: Record<string, unknown> = {}) => ({ id: executionId, scope, functionId, revisionNumber: 2, codeDigest: "a".repeat(64), state: "failed", trigger: "manual", scheduleId: null, retryOf: null, attempt: 1, output: null,
    errorCategory: "function.threw", createdBy: "a-1", revision: "3", createdAt: "2026-10-10T08:00:00Z", startedAt: "2026-10-10T08:00:01Z", completedAt: "2026-10-10T08:00:02Z", hasLogs: true, prunedAt: null, ...overrides });
  let current = execution(); let granted = ["metadata.read", "resources.configure", "data.write"];
  const net = network({
    "/platform/v1/account/session": () => json({ session: { id: "s-1", expiresAt: "2026-10-12T00:00:00Z", account: { id: "a-1", name: "Ada", securityRevision: "1", permissionRevision: "1" } } }),
    [`/platform/v1/orgs/${org}`]: () => json({ organization: { id: org, name: "North Works", slug: "north-works", state: "active", revision: "6", role: "Owner", membershipId: "m-1", membershipRevision: "1", requireMfa: false }, transfer: null }),
    [`/platform/v1/orgs/${org}/access`]: () => json({ scope, permissions: granted, permissionRevision: "1", membershipRevision: "1", organizationRevision: "6" }),
    [`/platform/v1/orgs/${org}/projects/${projectId}`]: () => json({ id: projectId, orgId: org, name: "Notes", slug: "notes", state: "active", revision: "2", productionMutationsAllowed: true, createdAt: "2026-10-02T00:00:00Z" }),
    [env]: () => json({ environment: { id: environmentId, orgId: org, projectId, name: "Development", kind: "development", state: "active", revision: "3", provisioning: "ready", createdAt: "2026-10-02T00:00:00Z" }, bindings: [] }),
    [`${env}/functions`]: init => init.method === "POST" ? json({ function: { ...fn, id: "77777777-7777-4777-8777-777777777777", name: "second" }, message: "Function deployed" }, 201) : json({ items: [fn], nextCursor: null }),
    [`${env}/functions/${functionId}`]: init => init.method === "POST" ? json({ function: fn, message: "Revision activated" }) : json({ function: fn, revisions: [
      { number: 3, codeDigest: "c".repeat(64), secretNames: [], timeoutSeconds: 30, createdBy: "a-1", createdAt: "2026-10-09T00:00:00Z" }, { number: 2, codeDigest: "b".repeat(64), secretNames: ["API_KEY"], timeoutSeconds: 45, createdBy: "a-1", createdAt: "2026-10-05T00:00:00Z" }] }),
    [`${env}/functions/${functionId}/revisions/2`]: () => json({ revision: { number: 2, codeDigest: "b".repeat(64), secretNames: ["API_KEY"], timeoutSeconds: 45, createdBy: "a-1", createdAt: "2026-10-05T00:00:00Z" }, code: "export default () => 'two';" }),
    [`${env}/functions/${functionId}/executions`]: () => json({ items: [current], nextCursor: null }),
    [`${env}/functions/${functionId}/invoke`]: () => json({ execution: execution({ state: "queued", errorCategory: null, hasLogs: false }), message: "Execution queued" }, 202),
    [`${env}/functions/${functionId}/schedules`]: init => init.method === "POST" ? json({ schedule: { id: scheduleId }, message: "Schedule created" }, 201) : json({ items: [
      { id: scheduleId, functionId, intervalSeconds: null, cron: "30 9 * * 1-5", timeZone: "Europe/Brussels", input: { report: "daily" }, state: "active", nextRunAt: "2026-10-12T07:30:00Z", lastRunAt: "2026-10-09T07:30:00Z",
        lastSkippedAt: "2026-10-08T07:30:00Z", lastSkipReason: "overlap", revision: "4", createdAt: "2026-10-01T00:00:00Z" }] }),
    [`${env}/schedules/${scheduleId}`]: () => json({ schedule: { id: scheduleId }, message: "Schedule paused" }),
    [`${env}/executions/${executionId}`]: init => init.method === "POST" ? json({ execution: current, message: "Execution cancelled" }) : json(current),
    [`${env}/executions/${executionId}/logs`]: () => current.hasLogs ? json({ executionId, attempt: 1, text: "Error: upstream refused [redacted]\n    at handler", truncated: true, recordedAt: "2026-10-10T08:00:02Z" })
      : json({ error: { code: "not_found", message: "This execution has no logs", requestId: "r-2" } }, 404),
  });
  const page = async (path: string) => { const shown = await mount(path, net.send); return shown; };
  const done = () => { view!.unmount(); view = undefined; };
  const honest = (shown: string) => { for (const word of ["mock", "fake", "simulated", "fixture", "memory", "concurrency", "draft"]) expect([word, shown.toLowerCase().includes(word)]).toEqual([word, false]); expect(shown).not.toContain("not connected"); };

  // The list: names and states as the service gave them.
  const list = await page(pages); honest(list); for (const text of ["report", "active", "revision ", "Deploy a new function"]) expect([text, list.includes(text)]).toEqual([text, true]); done();

  // One function: its revisions, which one runs, its executions, and the commands the service has.
  const detail = await page(`${pages}/${functionId}`); honest(detail);
  for (const text of ["report", "running revision ", "(active)", "API_KEY", "Activate a revision", "Deploy a new revision", "Disable this function", "Invoke", "function.threw", "Schedules"]) expect([text, detail.includes(text)]).toEqual([text, true]);
  // Reading a revision's code is its own request, made only when asked.
  expect(net.calls.some(call => call.path.includes("/revisions/"))).toBe(false);
  const forms = () => view!.root.findAllByType("form"); const formTitled = (title: string) => forms().find(form => JSON.stringify(form.findByType("h3").props.children).includes(title))!;
  const fill = async (form: ReturnType<typeof formTitled>, values: Record<string, string>) => {
    for (const [index, value] of Object.values(values).entries()) { const control = form.findAll(node => node.type === "textarea" || node.type === "input")[index]!; await act(async () => { control.props.onChange({ target: { value } }); }); }
  };
  const submit = async (form: ReturnType<typeof formTitled>) => { await act(async () => { await form.props.onSubmit({ preventDefault() {} }); }); await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
  // Invoking with something that is not JSON is stopped on the page: nothing is sent.
  net.calls.length = 0; await fill(formTitled("Invoke"), { input: "{not json" }); await submit(formTitled("Invoke"));
  expect(net.calls.filter(call => call.method === "POST")).toEqual([]);
  await fill(formTitled("Invoke"), { input: '{"month":"2026-10"}' }); await submit(formTitled("Invoke"));
  const invoked = net.calls.find(call => call.method === "POST")!; expect([invoked.path, invoked.body]).toEqual([`${env}/functions/${functionId}/invoke`, { input: { month: "2026-10" } }]);
  expect(invoked.headers.get("x-csrf-token")).toBe("t"); expect(invoked.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/); expect(invoked.headers.has("if-match")).toBe(false);
  done();
  // Activating names the function's current revision, so it cannot land on a state the page never showed.
  await page(`${pages}/${functionId}`); net.calls.length = 0; await fill(formTitled("Activate a revision"), { number: "3" }); await submit(formTitled("Activate a revision"));
  const activated = net.calls.find(call => call.method === "POST")!; expect([activated.path, activated.body, activated.headers.get("if-match")]).toEqual([`${env}/functions/${functionId}`, { kind: "activate", revision: 3 }, "5"]); done();

  // An execution that failed: what happened, what it printed, that the log was cut, and the way to run it again. No output is shown for a failure.
  const failed = await page(`${pages}/${functionId}/invocations/${executionId}`); honest(failed);
  for (const text of ["failed (function.threw)", "upstream refused [redacted]", "cut at its size limit", "Run it again", "only when it succeeds"]) expect([text, failed.includes(text)]).toEqual([text, true]);
  expect(failed).not.toContain("Cancel this execution"); done();
  // One still running: no log yet, and it can be cancelled, with its revision.
  current = execution({ state: "running", errorCategory: null, hasLogs: false, completedAt: null, revision: "2" });
  net.calls.length = 0; const running = await page(`${pages}/${functionId}/invocations/${executionId}`);
  for (const text of ["has not finished", "The log arrives when the execution finishes", "Cancel this execution"]) expect([text, running.includes(text)]).toEqual([text, true]);
  // The service said there is no log yet, so the page does not ask for one.
  expect(running).not.toContain("Run it again"); expect(net.calls.some(call => call.path.endsWith("/logs"))).toBe(false);
  net.calls.length = 0; await submit(formTitled("Cancel this execution"));
  const cancelled = net.calls.find(call => call.method === "POST")!; expect([cancelled.path, cancelled.body, cancelled.headers.get("if-match")]).toEqual([`${env}/executions/${executionId}`, { kind: "cancel" }, "2"]); done();
  // One whose contents were removed says so, and shows neither output nor log.
  current = execution({ state: "succeeded", errorCategory: null, hasLogs: false, output: null, prunedAt: "2026-11-09T08:00:02Z" });
  const pruned = await page(`${pages}/${functionId}/invocations/${executionId}`); expect(pruned).toContain("were removed on"); expect(pruned).toContain("thirty days"); expect(pruned).not.toContain("It printed nothing"); done();

  // Schedules: the rhythm in words, why the last slot was skipped, and both kinds of new schedule.
  const schedules = await page(`${pages}/${functionId}/schedules`); honest(schedules);
  for (const text of ["30 9 * * 1-5 in ", "Europe/Brussels", "the previous run had not finished", "daily", "Run on a calendar", "Run on an interval", "Pause", "clocks went forward"]) expect([text, schedules.includes(text)]).toEqual([text, true]);
  net.calls.length = 0; await fill(formTitled("Run on a calendar"), { cron: "0 6 * * *", zone: "America/New_York", input: '{"shift":"early"}' }); await submit(formTitled("Run on a calendar"));
  expect(net.calls.find(call => call.method === "POST")!.body).toEqual({ cron: "0 6 * * *", timeZone: "America/New_York", input: { shift: "early" } });
  net.calls.length = 0; await fill(formTitled("Run on an interval"), { seconds: "900" }); await submit(formTitled("Run on an interval"));
  expect(net.calls.find(call => call.method === "POST")!.body).toEqual({ intervalSeconds: 900 });
  net.calls.length = 0; await fill(formTitled("Run on an interval"), { seconds: "900", input: "{bad" }); await submit(formTitled("Run on an interval")); expect(net.calls.filter(call => call.method === "POST")).toEqual([]);
  net.calls.length = 0; await submit(formTitled("Pause"));
  const paused = net.calls.find(call => call.method === "POST")!; expect([paused.path, paused.body, paused.headers.get("if-match")]).toEqual([`${env}/schedules/${scheduleId}`, { kind: "pause" }, "4"]); done();

  // A member who may only read sees everything and can change nothing: every command is disabled.
  granted = ["metadata.read"]; current = execution();
  await page(`${pages}/${functionId}`);
  for (const title of ["Activate a revision", "Deploy a new revision", "Disable this function", "Invoke"]) expect([title, formTitled(title).findByType("fieldset").props.disabled]).toEqual([title, true]);
  done();
  expect(net.calls.every(call => call.path.startsWith("/platform/v1/"))).toBe(true);
});

test("the server serves the built console and nothing outside it", () => {
  const root = mkdtempSync(join(tmpdir(), "carbon-console-"));
  try {
    expect(() => createFrontendRoutes(join(root, "missing"))).toThrow("bun run build:live");
    mkdirSync(join(root, "dist", "assets"), { recursive: true }); writeFileSync(join(root, "dist", "index.html"), "<!doctype html><title>Carbon Cloud</title>");
    writeFileSync(join(root, "dist", "assets", "index-abc123.js"), "console.log(1)"); writeFileSync(join(root, "secret.txt"), "outside the build");
    const serve = createFrontendRoutes(join(root, "dist")); const get = (path: string, method = "GET") => serve(new Request(`https://cloud.example.test${path}`, { method }));
    // Any path without an extension is the application; the browser routes it.
    for (const path of ["/", "/organizations", "/orgs/1/projects/2/overview", "/auth/complete"]) { const response = get(path); expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8"); expect(response.headers.get("cache-control")).toBe("no-store"); }
    const asset = get("/assets/index-abc123.js"); expect(asset.status).toBe(200); expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8"); expect(asset.headers.get("cache-control")).toContain("immutable");
    // A missing file is a 404, not the application, and nothing outside the build is reachable.
    for (const path of ["/assets/missing.js", "/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/secret.txt", "/assets/..%5c..%5csecret.txt"]) expect([path, get(path).status]).toEqual([path, 404]);
    expect(get("/organizations", "POST").status).toBe(405); expect(get("/", "HEAD").status).toBe(200);
    // The page may load and call only its own origin, and cannot be framed.
    const headers = get("/").headers; expect(headers.get("content-security-policy")).toContain("connect-src 'self'"); expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'"); expect(headers.get("x-content-type-options")).toBe("nosniff");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
