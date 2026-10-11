import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformApiError, PlatformCredentialClient, resolvePlatformCredential, type PlatformCredential, type PlatformRequest } from "../infrastructure/cloud/PlatformCredentialClient.ts";
import { platformCommand, type PlatformCommandDependencies, type PlatformFamily } from "../presentation/commands/cloud/platform.command.ts";

const ORG = "11111111-1111-4111-8111-111111111111"; const PROJECT = "22222222-2222-4222-8222-222222222222"; const ENV = "33333333-3333-4333-8333-333333333333";
const ID = "44444444-4444-4444-8444-444444444444"; const OTHER = "55555555-5555-4555-8555-555555555555";
const TOKEN = `pt_${"A".repeat(43)}`; const scope = { orgId: ORG, projectId: PROJECT, environmentId: ENV };
const credential: PlatformCredential = { controlPlaneUrl: "https://cloud.example.test", token: TOKEN, scope };
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/** Runs a command against scripted answers and records exactly what it asked Cloud for. */
function harness(answers: (request: PlatformRequest) => unknown = () => ({})) {
  const requests: PlatformRequest[] = []; const printed: string[] = []; let slept = 0;
  const dependencies: PlatformCommandDependencies = {
    credential: async () => credential, print: text => { printed.push(text); }, sleep: async () => { slept++; },
    client: { request: async (_credential, request) => { requests.push(request); const answer = answers(request); if (answer instanceof Error) throw answer; return answer; } },
  };
  const run = (family: PlatformFamily, ...args: string[]) => platformCommand(family, args, dependencies);
  return { run, requests, printed, sleeps: () => slept };
}
const shape = (request: PlatformRequest) => [request.method, request.path, request.body, request.revision];

describe("carbon cloud builds, releases, channels and functions", () => {
  test("each subcommand asks Cloud for exactly one thing, and prints its answer as JSON", async () => {
    const h = harness(() => ({ items: [] }));
    expect(await h.run("builds", "list")).toBe(0); expect(await h.run("builds", "show", ID)).toBe(0); expect(await h.run("builds", "logs", ID, "--after", "12")).toBe(0);
    expect(await h.run("builds", "provenance", ID)).toBe(0); expect(await h.run("releases", "list")).toBe(0); expect(await h.run("releases", "show", ID)).toBe(0);
    expect(await h.run("channels", "list")).toBe(0); expect(await h.run("channels", "show", "stable")).toBe(0);
    expect(await h.run("functions", "list")).toBe(0); expect(await h.run("functions", "show", ID)).toBe(0); expect(await h.run("functions", "executions", ID)).toBe(0);
    expect(await h.run("functions", "schedules", ID)).toBe(0); expect(await h.run("functions", "execution", ID)).toBe(0); expect(await h.run("functions", "logs", ID)).toBe(0);
    expect(h.requests.map(request => [request.method, request.path])).toEqual([["GET", "/builds"], ["GET", `/builds/${ID}`], ["GET", `/builds/${ID}/logs?after=12`], ["GET", `/builds/${ID}/provenance`],
      ["GET", "/releases"], ["GET", `/releases/${ID}`], ["GET", "/channels"], ["GET", "/channels/stable"], ["GET", "/functions"], ["GET", `/functions/${ID}`], ["GET", `/functions/${ID}/executions`],
      ["GET", `/functions/${ID}/schedules`], ["GET", `/executions/${ID}`], ["GET", `/executions/${ID}/logs`]]);
    // Standard output is the answer and nothing else, so it can be piped.
    expect(h.printed).toHaveLength(14); for (const text of h.printed) expect(JSON.parse(text)).toEqual({ items: [] });
  });

  test("lists are read a page at a time, with the cursor Cloud gave", async () => {
    const h = harness(() => ({ items: [], nextCursor: null }));
    expect(await h.run("builds", "list", "--limit", "50", "--cursor", "abc.DEF_123-~")).toBe(0); expect(await h.run("releases", "list", "--limit", "1")).toBe(0);
    expect(await h.run("functions", "list", "--cursor", "c2")).toBe(0); expect(await h.run("functions", "executions", ID, "--limit", "100", "--cursor", "c3")).toBe(0);
    expect(h.requests.map(request => request.path)).toEqual(["/builds?limit=50&cursor=abc.DEF_123-%7E", "/releases?limit=1", "/functions?cursor=c2", `/functions/${ID}/executions?limit=100&cursor=c3`]);
    for (const args of [["builds", "list", "--limit", "0"], ["builds", "list", "--limit", "101"], ["builds", "list", "--cursor", "a b"], ["builds", "list", "--cursor", "../x"], ["functions", "list", "--cursor", ""]] as const) {
      const bad = harness(); expect([args.join(" "), await bad.run(args[0] as PlatformFamily, ...args.slice(1)), bad.requests.length]).toEqual([args.join(" "), 2, 0]);
    }
  });

  test("creating things sends what was asked, once, each with its own idempotency key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "carbon-cli-platform-")); temporary.push(directory);
    const module = join(directory, "fn.js"); writeFileSync(module, "export default () => 1;\n"); const release = join(directory, "release.json"); writeFileSync(release, JSON.stringify({ buildId: ID, version: "1.2.3" }));
    const h = harness();
    expect(await h.run("builds", "create", "--repo", "https://github.com/acme/app.git", "--commit", "a".repeat(40), "--target", "nsis", "--target", "wix", "--platform", "windows", "--secret", "NPM_TOKEN")).toBe(0);
    expect(await h.run("functions", "deploy", "report", "--file", module, "--secret", "API_KEY", "--secret", "DB_URL", "--timeout", "45")).toBe(0);
    expect(await h.run("functions", "deploy", "plain", "--file", module)).toBe(0);
    expect(await h.run("releases", "create", "--file", release)).toBe(0);
    expect(await h.run("functions", "invoke", ID, "--input", '{"n":1}')).toBe(0); expect(await h.run("functions", "invoke", ID)).toBe(0);
    expect(await h.run("functions", "schedule", ID, "--every", "3600")).toBe(0);
    expect(await h.run("functions", "schedule", ID, "--cron", "30 9 * * 1-5", "--zone", "Europe/Brussels", "--input", '{"report":"daily"}')).toBe(0);
    expect(h.requests.map(shape)).toEqual([
      ["POST", "/builds", { repositoryUrl: "https://github.com/acme/app.git", commitSha: "a".repeat(40), targets: ["nsis", "wix"], secretNames: ["NPM_TOKEN"], platform: "windows" }, undefined],
      ["POST", "/functions", { name: "report", code: "export default () => 1;\n", secretNames: ["API_KEY", "DB_URL"], timeoutSeconds: 45 }, undefined],
      ["POST", "/functions", { name: "plain", code: "export default () => 1;\n", secretNames: [], timeoutSeconds: 30 }, undefined],
      ["POST", "/releases", { buildId: ID, version: "1.2.3" }, undefined],
      ["POST", `/functions/${ID}/invoke`, { input: { n: 1 } }, undefined], ["POST", `/functions/${ID}/invoke`, { input: null }, undefined],
      ["POST", `/functions/${ID}/schedules`, { intervalSeconds: 3600 }, undefined],
      ["POST", `/functions/${ID}/schedules`, { cron: "30 9 * * 1-5", timeZone: "Europe/Brussels", input: { report: "daily" } }, undefined],
    ]);
    const keys = h.requests.map(request => request.idempotencyKey); expect(new Set(keys).size).toBe(keys.length); for (const key of keys) expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a command on something that exists is sent with the revision it has now", async () => {
    const h = harness(request => request.method === "GET"
      ? request.path.startsWith("/builds/") ? { build: { revision: "7" }, artifacts: [] } : request.path.startsWith("/channels/") ? { channel: { revision: "3" }, revisions: [] }
        : request.path.startsWith("/functions/") ? { function: { revision: "5" } } : { revision: "9" }
      : { done: true });
    expect(await h.run("builds", "cancel", ID)).toBe(0); expect(await h.run("releases", "withdraw", ID, "--reason", "bad build")).toBe(0);
    expect(await h.run("channels", "publish", "stable", "--release", OTHER, "--rollout", "25")).toBe(0); expect(await h.run("channels", "rollout", "stable", "--rollout", "100")).toBe(0);
    expect(await h.run("channels", "command", "beta", "--command", '{"kind":"pause"}')).toBe(0);
    expect(await h.run("functions", "cancel", ID)).toBe(0); expect(await h.run("functions", "retry", ID)).toBe(0);
    expect(await h.run("functions", "disable", ID)).toBe(0); expect(await h.run("functions", "enable", ID)).toBe(0); expect(await h.run("functions", "activate", ID, "--revision", "2")).toBe(0);
    // Every command is a read of the current revision followed by one write that names it.
    expect(h.requests.filter(request => request.method === "POST").map(shape)).toEqual([
      ["POST", `/builds/${ID}`, { kind: "cancel" }, "7"], ["POST", `/releases/${ID}`, { kind: "withdraw", reason: "bad build" }, "9"],
      ["POST", "/channels/stable", { kind: "publish", releaseId: OTHER, rollout: 25 }, "3"], ["POST", "/channels/stable", { kind: "rollout", rollout: 100 }, "3"], ["POST", "/channels/beta", { kind: "pause" }, "3"],
      ["POST", `/executions/${ID}`, { kind: "cancel" }, "9"], ["POST", `/executions/${ID}`, { kind: "retry" }, "9"],
      ["POST", `/functions/${ID}`, { kind: "disable" }, "5"], ["POST", `/functions/${ID}`, { kind: "enable" }, "5"], ["POST", `/functions/${ID}`, { kind: "activate", revision: 2 }, "5"],
    ]);
    expect(h.requests.map(request => request.method)).toEqual(Array(10).fill(["GET", "POST"]).flat());
    // No revision in Cloud's answer: the command is not sent blind.
    const blind = harness(() => ({})); expect(await blind.run("builds", "cancel", ID)).toBe(1); expect(blind.requests.map(request => request.method)).toEqual(["GET"]);
  });

  test("invoke --wait follows the execution until it is over, and never invokes twice", async () => {
    const states = ["queued", "running", "running", "succeeded"]; let reads = 0;
    const h = harness(request => request.method === "POST" ? { execution: { id: OTHER, state: "queued" }, message: "queued" } : { id: OTHER, state: states[Math.min(reads++, states.length - 1)], output: { ok: true } });
    expect(await h.run("functions", "invoke", ID, "--wait")).toBe(0);
    expect(h.requests.map(request => [request.method, request.path])).toEqual([["POST", `/functions/${ID}/invoke`], ...Array(4).fill(["GET", `/executions/${OTHER}`])]);
    expect(h.sleeps()).toBe(3); expect(JSON.parse(h.printed.at(-1)!)).toEqual({ id: OTHER, state: "succeeded", output: { ok: true } });
    // Without --wait the receipt is printed and nothing is followed.
    const quick = harness(() => ({ execution: { id: OTHER, state: "queued" } })); expect(await quick.run("functions", "invoke", ID)).toBe(0); expect(quick.requests).toHaveLength(1);
    // An execution that never finishes is given up on after the limit, with the command to keep following it. It is not invoked again.
    const realNow = Date.now; let clock = realNow();
    const stuck = harness(request => request.method === "POST" ? { execution: { id: OTHER, state: "queued" } } : { id: OTHER, state: "running" });
    Date.now = () => (clock += 400);
    try { expect(await stuck.run("functions", "invoke", ID, "--wait", "--wait-seconds", "2")).toBe(1); } finally { Date.now = realNow; }
    expect(stuck.requests.filter(request => request.method === "POST")).toHaveLength(1); expect(stuck.requests.length).toBeGreaterThan(2);
    // A failed execution is still an answer: printed, exit code 0, and the state says what happened.
    const failed = harness(request => request.method === "POST" ? { execution: { id: OTHER, state: "queued" } } : { id: OTHER, state: "failed", errorCategory: "function.threw" });
    expect(await failed.run("functions", "invoke", ID, "--wait")).toBe(0); expect(JSON.parse(failed.printed.at(-1)!).state).toBe("failed");
  });

  test("wrong usage is refused before anything is sent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "carbon-cli-platform-")); temporary.push(directory); const notJson = join(directory, "bad.json"); writeFileSync(notJson, "{not json");
    const cases: [PlatformFamily, string[]][] = [
      ["builds", ["show"]], ["builds", ["show", "not-an-id"]], ["builds", ["show", ID, OTHER]], ["builds", ["logs", ID, "--after", "-1"]], ["builds", ["logs", ID, "--after", "x"]], ["builds", ["list", "--all"]],
      ["builds", ["create", "--repo", "https://github.com/acme/app.git"]], ["builds", ["create", "--repo"]], ["builds", ["create", "--repo", "a", "--repo", "b", "--commit", "c", "--target", "t", "--platform", "windows"]],
      ["builds", ["nonsense"]], ["releases", ["create"]], ["releases", ["create", "--file", join(directory, "missing.json")]], ["releases", ["create", "--file", notJson]], ["releases", ["withdraw", ID]],
      ["channels", ["show", "Not A Name"]], ["channels", ["show", "../builds"]], ["channels", ["publish", "stable", "--release", ID]], ["channels", ["publish", "stable", "--release", "x", "--rollout", "10"]],
      ["channels", ["rollout", "stable", "--rollout", "101"]], ["channels", ["command", "stable"]], ["channels", ["command", "stable", "--command", "{bad"]], ["channels", ["create"]],
      ["functions", ["deploy", "name"]], ["functions", ["deploy", "--file", notJson]], ["functions", ["deploy", "name", "--file", notJson, "--timeout", "0"]], ["functions", ["deploy", "name", "--file", notJson, "--timeout", "301"]],
      ["functions", ["invoke", ID, "--input", "{bad"]], ["functions", ["invoke", ID, "--wait", "--wait-seconds", "0"]], ["functions", ["schedule", ID]], ["functions", ["schedule", ID, "--every", "60", "--cron", "* * * * *", "--zone", "UTC"]],
      ["functions", ["schedule", ID, "--cron", "* * * * *"]], ["functions", ["schedule", ID, "--every", "60", "--zone", "UTC"]], ["functions", ["schedule", ID, "--every", "59"]], ["functions", ["activate", ID]],
      ["functions", ["activate", ID, "--revision", "0"]], ["functions", ["logs"]],
    ];
    for (const [family, args] of cases) { const h = harness(); expect([family, args.join(" "), await h.run(family, ...args), h.requests.length, h.printed.length]).toEqual([family, args.join(" "), 2, 0, 0]); }
    // Help is printed and nothing is sent. Asking for help succeeds; giving no subcommand at all is a usage error.
    const help = harness(); expect(await help.run("functions", "--help")).toBe(0); expect(await help.run("builds")).toBe(2); expect(help.requests).toEqual([]); expect(help.printed[0]).toContain("carbon cloud functions");
  });

  test("a refusal from Cloud, an unreachable Cloud and a missing login each fail with exit code 1 and print nothing", async () => {
    for (const failure of [new PlatformApiError(403, "forbidden", "Running functions is not permitted"), new PlatformApiError(404, "not_found", "Function not found"), new Error("Carbon Cloud could not be reached")]) {
      const h = harness(() => failure); expect(await h.run("functions", "invoke", ID)).toBe(1); expect(h.printed).toEqual([]); expect(h.requests).toHaveLength(1);
    }
    const loggedOut: PlatformCommandDependencies = { credential: async () => { throw new Error("no active device login"); }, client: { request: async () => { throw new Error("must not be called"); } }, print: () => { throw new Error("must not print"); }, sleep: async () => {} };
    expect(await platformCommand("builds", ["list"], loggedOut)).toBe(1);
  });
});

describe("where the credential comes from", () => {
  const device = (grantScope: Record<string, string>, token = `dc_${"B".repeat(43)}`) => ({ active: async () => ({ token, profile: { id: ID, controlPlaneUrl: "https://cloud.example.test", grant: { scope: grantScope } } }) }) as never;
  const none = { active: async () => null } as never;

  test("CARBON_TOKEN names a credential outright and then needs the Cloud URL and the environment spelled out", async () => {
    const env = { CARBON_TOKEN: TOKEN, CARBON_CLOUD_URL: "https://cloud.example.test", CARBON_ORG: ORG, CARBON_PROJECT: PROJECT, CARBON_ENVIRONMENT: ENV };
    expect(await resolvePlatformCredential(none, env)).toEqual(credential);
    // It wins over a device login, so automation is never surprised by a developer's saved login.
    expect((await resolvePlatformCredential(device(scope), env)).token).toBe(TOKEN);
    const refused = (value: Record<string, string | undefined>) => resolvePlatformCredential(none, value as NodeJS.ProcessEnv).then(() => "accepted", error => (error as Error).message);
    expect(await refused({ ...env, CARBON_PROJECT: undefined, CARBON_ENVIRONMENT: undefined })).toBe("CARBON_TOKEN also needs CARBON_PROJECT, CARBON_ENVIRONMENT");
    expect(await refused({ ...env, CARBON_TOKEN: "cs_" + "A".repeat(43) })).toBe("CARBON_TOKEN is not a device or personal credential");
    expect(await refused({ ...env, CARBON_TOKEN: "pt_short" })).toBe("CARBON_TOKEN is not a device or personal credential");
    expect(await refused({ ...env, CARBON_ORG: "acme" })).toBe("CARBON_ORG, CARBON_PROJECT and CARBON_ENVIRONMENT must be identifiers");
    for (const url of ["http://cloud.example.test", "https://user:pass@cloud.example.test", "https://cloud.example.test/path", "not a url"]) expect(await refused({ ...env, CARBON_CLOUD_URL: url })).not.toBe("accepted");
    expect((await resolvePlatformCredential(none, { ...env, CARBON_CLOUD_URL: "http://127.0.0.1:8080" })).controlPlaneUrl).toBe("http://127.0.0.1:8080");
  });

  test("otherwise the device login is used, and only one that is for a single environment", async () => {
    expect(await resolvePlatformCredential(device(scope), {})).toEqual({ controlPlaneUrl: "https://cloud.example.test", token: `dc_${"B".repeat(43)}`, scope });
    const refused = (store: never) => resolvePlatformCredential(store, {}).then(() => "accepted", error => (error as Error).message);
    expect(await refused(none)).toContain("no active device login");
    expect(await refused(device({ orgId: ORG }))).toContain("not for one environment"); expect(await refused(device({ orgId: ORG, projectId: PROJECT }))).toContain("not for one environment");
    expect(await refused(device({ ...scope, realmId: ID }))).toContain("not for one environment");
  });
});

describe("the request on the wire", () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => (requestId: string) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": requestId, ...headers } });
  const client = (answer: (requestId: string) => Response) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const transport = (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init: init! }); return answer(new Headers(init!.headers).get("x-request-id")!); }) as typeof fetch;
    return { client: new PlatformCredentialClient(transport), seen };
  };

  test("carries the credential and nothing a browser would, to exactly this environment", async () => {
    const { client: get, seen } = client(reply(200, { items: [] }));
    expect(await get.request(credential, { method: "GET", path: "/functions" })).toEqual({ items: [] });
    const headers = new Headers(seen[0]!.init.headers);
    expect(seen[0]!.url).toBe(`https://cloud.example.test/platform/v1/orgs/${ORG}/projects/${PROJECT}/environments/${ENV}/functions`);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`); expect(headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    for (const name of ["cookie", "origin", "x-csrf-token", "idempotency-key", "if-match", "content-type"]) expect([name, headers.has(name)]).toEqual([name, false]);
    expect(seen[0]!.init.method).toBe("GET"); expect(seen[0]!.init.body).toBeUndefined(); expect(seen[0]!.init.redirect).toBe("error");

    const { client: post, seen: sent } = client(reply(202, { execution: { id: ID } }));
    await post.request(credential, { method: "POST", path: `/functions/${ID}/invoke`, body: { input: 1 }, revision: "4", idempotencyKey: OTHER });
    const posted = new Headers(sent[0]!.init.headers);
    expect([posted.get("content-type"), posted.get("idempotency-key"), posted.get("if-match"), sent[0]!.init.body]).toEqual(["application/json", OTHER, "4", '{"input":1}']);
    for (const name of ["cookie", "origin", "x-csrf-token"]) expect([name, posted.has(name)]).toEqual([name, false]);
  });

  test("a refusal becomes an error with Cloud's code, and a reply that is not what was asked for is not trusted", async () => {
    const failing = (status: number, body: unknown) => client(reply(status, body)).client.request(credential, { method: "GET", path: "/functions" }).then(() => "answered", error => error);
    expect(await failing(403, { error: { code: "forbidden", message: "Running functions is not permitted" } })).toMatchObject({ status: 403, code: "forbidden", message: "Running functions is not permitted" });
    // 401 says nothing more than that the credential did not work, whatever the body claims.
    expect(await failing(401, { error: { code: "unauthenticated", message: "token pt_secret is revoked" } })).toMatchObject({ status: 401, message: "The credential is invalid, expired or revoked" });
    expect(await failing(500, { nonsense: true })).toMatchObject({ status: 500, code: "unavailable", message: "Carbon Cloud answered 500" });
    expect(await failing(503, { error: { code: "unavailable", message: "x".repeat(400) } })).toMatchObject({ message: "Carbon Cloud answered 503" });
    const untrusted = async (answer: (requestId: string) => Response) => client(answer).client.request(credential, { method: "GET", path: "/functions" }).then(() => "answered", error => (error as Error).message);
    expect(await untrusted(() => new Response('{"items":[]}', { headers: { "content-type": "application/json", "x-request-id": OTHER } }))).toBe("Carbon Cloud returned an invalid response");
    expect(await untrusted(requestId => new Response("<html>", { headers: { "content-type": "text/html", "x-request-id": requestId } }))).toBe("Carbon Cloud returned an invalid response");
    expect(await untrusted(requestId => new Response("{not json", { headers: { "content-type": "application/json", "x-request-id": requestId } }))).toBe("Carbon Cloud returned invalid JSON");
    expect(await untrusted(requestId => new Response("x".repeat(2_200_000), { headers: { "content-type": "application/json", "x-request-id": requestId } }))).toBe("Carbon Cloud returned an oversized response");
    const down = new PlatformCredentialClient((async () => { throw new Error("ECONNREFUSED 10.0.0.1"); }) as never);
    expect(await down.request(credential, { method: "GET", path: "/functions" }).then(() => "answered", error => (error as Error).message)).toBe("Carbon Cloud could not be reached");
  });

  test("nothing but a path below the environment, and nothing but a device or personal credential, is ever sent", async () => {
    const { client: guarded, seen } = client(reply(200, {}));
    const refused = (path: string, token = TOKEN) => guarded.request({ ...credential, token }, { method: "GET", path }).then(() => "sent", () => "refused");
    for (const path of ["functions", "/../../../account/session", "/functions/../../secrets", "//evil.example.test/x", "/functions?x=1#frag", "/functions\nx-injected: 1", "/functions x"]) expect([path, await refused(path)]).toEqual([path, "refused"]);
    for (const token of [`as_${"A".repeat(43)}`, `cs_${"A".repeat(43)}`, "pt_short", ""]) expect([token, await refused("/functions", token)]).toEqual([token, "refused"]);
    expect(await guarded.request({ ...credential, controlPlaneUrl: "http://cloud.example.test" }, { method: "GET", path: "/functions" }).then(() => "sent", () => "refused")).toBe("refused");
    expect(seen).toEqual([]);
    expect(await refused("/builds/x/logs?after=3")).toBe("sent");
  });
});
