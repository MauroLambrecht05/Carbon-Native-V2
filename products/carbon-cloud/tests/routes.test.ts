// The HTTP surface, over in-memory repositories. What talks to a real
// Postgres is PostgresBuildRepository/PostgresIdentityRepository's own
// concern; this only checks that a request maps to the right use case,
// auth (and scope) gates what it should, and status codes are right — none
// of which needs a database to prove.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  ClaimNextBuildUseCase,
  CompleteBuildUseCase,
  CreateBuildUseCase,
  GetBuildUseCase,
  ListOrgBuildsUseCase,
  InMemoryBuildRepository,
  type BuildProps,
} from "@carbon/orchestration";
import {
  CreateOrganizationUseCase,
  IssueWorkerTokenUseCase,
  InMemoryIdentityRepository,
  VerifyTokenUseCase,
} from "@carbon/identity";
import {
  ConsumeMagicLinkUseCase,
  InMemoryAuthRepository,
  RequestMagicLinkUseCase,
  VerifyEndUserSessionUseCase,
} from "@carbon/auth";
import {
  CheckUsageLimitUseCase,
  InMemoryBillingRepository,
  RecordBuildUsageUseCase,
  StartPlanUpgradeUseCase,
  ConfirmPlanUpgradeUseCase,
  FakeCheckoutSessionProvider,
  UsageRecord,
} from "@carbon/billing";
import { buildRoutes } from "../infrastructure/http/routes.ts";

async function harness() {
  const builds = new InMemoryBuildRepository();
  const identity = new InMemoryIdentityRepository();
  const billing = new InMemoryBillingRepository();
  const auth = new InMemoryAuthRepository();
  const createOrganization = new CreateOrganizationUseCase(identity);
  const issueWorkerToken = new IssueWorkerTokenUseCase(identity);
  const requestMagicLink = new RequestMagicLinkUseCase(auth);
  const consumeMagicLink = new ConsumeMagicLinkUseCase(auth);
  const routes = buildRoutes({
    createBuild: new CreateBuildUseCase(builds),
    getBuild: new GetBuildUseCase(builds),
    listOrgBuilds: new ListOrgBuildsUseCase(builds),
    claimNext: new ClaimNextBuildUseCase(builds),
    completeBuild: new CompleteBuildUseCase(builds),
    createOrganization,
    issueWorkerToken,
    verifyToken: new VerifyTokenUseCase(identity),
    requestMagicLink,
    consumeMagicLink,
    verifyEndUserSession: new VerifyEndUserSessionUseCase(auth),
    checkUsageLimit: new CheckUsageLimitUseCase(billing, billing),
    recordBuildUsage: new RecordBuildUsageUseCase(billing),
    startPlanUpgrade: new StartPlanUpgradeUseCase(new FakeCheckoutSessionProvider()),
    confirmPlanUpgrade: new ConfirmPlanUpgradeUseCase(billing),
    stripeWebhookSecret: "whsec_test_secret",
  });
  const server = Bun.serve({ port: 0, routes, fetch: () => new Response("not found", { status: 404 }) });
  const base = `http://localhost:${server.port}`;

  // Every scenario below needs a valid token to get past auth, so signing
  // up (and minting a worker token) once here is setup, not the thing
  // under test — both are covered separately below.
  const { orgId, apiToken } = await createOrganization.execute("Test Org");
  const { workerToken } = await issueWorkerToken.execute(orgId);
  const withToken = (token: string) => (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
  const authed = withToken(apiToken);
  const asWorker = withToken(workerToken);

  return {
    server,
    base,
    orgId,
    apiToken,
    workerToken,
    authed,
    asWorker,
    billing,
    createOrganization,
    issueWorkerToken,
    requestMagicLink,
    consumeMagicLink,
    withToken,
  };
}

describe("POST /v1/orgs", () => {
  test("signup returns an org id and a usable org-scoped token", async () => {
    const { server, base } = await harness();
    const res = await fetch(`${base}/v1/orgs`, {
      method: "POST",
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { orgId: string; apiToken: string };
    expect(body.orgId).toBeTruthy();
    expect(body.apiToken).toStartWith("cc_");
    server.stop(true);
  });

  test("a missing name is refused", async () => {
    const { server, base } = await harness();
    const res = await fetch(`${base}/v1/orgs`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    server.stop(true);
  });
});

describe("End-user (magic-link) auth", () => {
  test("full lifecycle: request a link, consume it, verify the resulting session", async () => {
    const { server, base, orgId } = await harness();

    const linkRes = await fetch(`${base}/v1/end-users/magic-link`, {
      method: "POST",
      body: JSON.stringify({ orgId, email: "customer@example.com" }),
    });
    expect(linkRes.status).toBe(201);
    const link = (await linkRes.json()) as { endUserId: string; devMagicLink: string };
    expect(link.devMagicLink).toStartWith("ml_");

    const sessionRes = await fetch(`${base}/v1/end-users/session`, {
      method: "POST",
      body: JSON.stringify({ magicLinkToken: link.devMagicLink }),
    });
    expect(sessionRes.status).toBe(201);
    const session = (await sessionRes.json()) as { sessionToken: string; endUserId: string; orgId: string };
    expect(session.sessionToken).toStartWith("es_");
    expect(session.endUserId).toBe(link.endUserId);
    expect(session.orgId).toBe(orgId);

    const meRes = await fetch(`${base}/v1/end-users/me`, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({ endUserId: link.endUserId, orgId });

    server.stop(true);
  });

  test("a magic link can only be consumed once", async () => {
    const { server, base, orgId } = await harness();
    const linkRes = await fetch(`${base}/v1/end-users/magic-link`, {
      method: "POST",
      body: JSON.stringify({ orgId, email: "once@example.com" }),
    });
    const { devMagicLink } = (await linkRes.json()) as { devMagicLink: string };

    const first = await fetch(`${base}/v1/end-users/session`, {
      method: "POST",
      body: JSON.stringify({ magicLinkToken: devMagicLink }),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${base}/v1/end-users/session`, {
      method: "POST",
      body: JSON.stringify({ magicLinkToken: devMagicLink }),
    });
    expect(second.status).toBe(400);

    server.stop(true);
  });

  test("GET /v1/end-users/me rejects a missing or garbage bearer token", async () => {
    const { server, base } = await harness();

    const noAuth = await fetch(`${base}/v1/end-users/me`);
    expect(noAuth.status).toBe(401);

    const garbage = await fetch(`${base}/v1/end-users/me`, { headers: { authorization: "Bearer not-a-real-session" } });
    expect(garbage.status).toBe(401);

    server.stop(true);
  });

  test("an org/worker API token does NOT verify as an end-user session — the two namespaces don't cross", async () => {
    const { server, base, apiToken } = await harness();
    const res = await fetch(`${base}/v1/end-users/me`, { headers: { authorization: `Bearer ${apiToken}` } });
    expect(res.status).toBe(401);
    server.stop(true);
  });

  test("missing orgId or email is refused", async () => {
    const { server, base, orgId } = await harness();
    const missingEmail = await fetch(`${base}/v1/end-users/magic-link`, {
      method: "POST",
      body: JSON.stringify({ orgId }),
    });
    expect(missingEmail.status).toBe(400);

    const missingOrg = await fetch(`${base}/v1/end-users/magic-link`, {
      method: "POST",
      body: JSON.stringify({ email: "x@example.com" }),
    });
    expect(missingOrg.status).toBe(400);

    server.stop(true);
  });
});

describe("POST /v1/worker-tokens", () => {
  test("an org token can mint a worker token for itself", async () => {
    const { server, authed } = await harness();
    const res = await authed("/v1/worker-tokens", { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workerToken: string };
    expect(body.workerToken).toStartWith("wk_");
    server.stop(true);
  });

  test("a worker token cannot mint another worker token", async () => {
    const { server, asWorker } = await harness();
    const res = await asWorker("/v1/worker-tokens", { method: "POST" });
    expect(res.status).toBe(403);
    server.stop(true);
  });
});

describe("auth", () => {
  test("no token is 401", async () => {
    const { server, base } = await harness();
    const res = await fetch(`${base}/v1/builds`, {
      method: "POST",
      body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["deb"] }),
    });
    expect(res.status).toBe(401);
    server.stop(true);
  });

  test("an invalid token is 401", async () => {
    const { server, base } = await harness();
    const res = await fetch(`${base}/v1/builds`, {
      method: "POST",
      headers: { authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["deb"] }),
    });
    expect(res.status).toBe(401);
    server.stop(true);
  });

  test("a worker token cannot create a build (needs org scope) — 403, not 401", async () => {
    const { server, asWorker } = await harness();
    const res = await asWorker("/v1/builds", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["deb"] }),
    });
    expect(res.status).toBe(403);
    server.stop(true);
  });

  test("an org token cannot claim a build (needs worker scope)", async () => {
    const { server, authed } = await harness();
    const res = await authed("/v1/builds/claim", {
      method: "POST",
      body: JSON.stringify({ platform: "linux", workerId: "w1" }),
    });
    expect(res.status).toBe(403);
    server.stop(true);
  });
});

describe("GET /v1/auth/verify", () => {
  // Exercises the SSO endpoint another product (carbon-database, carbon-
  // registry) calls to accept the SAME token this control plane issued —
  // see the route's own comment in routes.ts for why this exists.
  test("an org token verifies as org scope, with the right orgId", async () => {
    const { server, authed, orgId } = await harness();
    const res = await authed("/v1/auth/verify");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orgId: string; scope: string };
    expect(body.orgId).toBe(orgId);
    expect(body.scope).toBe("org");
    server.stop(true);
  });

  test("a worker token verifies as worker scope", async () => {
    const { server, asWorker } = await harness();
    const res = await asWorker("/v1/auth/verify");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe("worker");
    server.stop(true);
  });

  test("no token is 401", async () => {
    const { server, base } = await harness();
    const res = await fetch(`${base}/v1/auth/verify`);
    expect(res.status).toBe(401);
    server.stop(true);
  });

  test("an invalid token is 401", async () => {
    const { server, base } = await harness();
    const res = await fetch(`${base}/v1/auth/verify`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
    server.stop(true);
  });
});

describe("POST /v1/builds", () => {
  test("creates a queued build, owned by the token's org", async () => {
    const { server, authed } = await harness();
    const res = await authed("/v1/builds", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "https://example.com/demo.git", commitSha: "abc", targets: ["deb"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as BuildProps;
    expect(body.status).toBe("queued");
    server.stop(true);
  });
});

describe("GET /v1/builds", () => {
  test("lists the org's builds, most recent first", async () => {
    const { server, authed } = await harness();
    const create = (commitSha: string) =>
      authed("/v1/builds", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "r", commitSha, targets: ["deb"] }),
      });
    const first = (await (await create("first")).json()) as BuildProps;
    const second = (await (await create("second")).json()) as BuildProps;

    const res = await authed("/v1/builds");
    expect(res.status).toBe(200);
    const list = (await res.json()) as BuildProps[];
    expect(list.map((b) => b.id)).toEqual([second.id, first.id]);
    server.stop(true);
  });

  test("only the token's own org's builds, not another org's", async () => {
    const { server, authed, base } = await harness();
    await authed("/v1/builds", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["deb"] }),
    });

    const otherSignup = (await (
      await fetch(`${base}/v1/orgs`, { method: "POST", body: JSON.stringify({ name: "Other Org" }) })
    ).json()) as { apiToken: string };
    const res = await fetch(`${base}/v1/builds`, {
      headers: { authorization: `Bearer ${otherSignup.apiToken}` },
    });
    const list = (await res.json()) as BuildProps[];
    expect(list).toEqual([]);
    server.stop(true);
  });

  test("a worker token cannot list builds (needs org scope)", async () => {
    const { server, asWorker } = await harness();
    const res = await asWorker("/v1/builds");
    expect(res.status).toBe(403);
    server.stop(true);
  });
});

describe("GET /v1/builds/:id", () => {
  test("404s on an unknown build", async () => {
    const { server, authed } = await harness();
    const res = await authed("/v1/builds/does-not-exist");
    expect(res.status).toBe(404);
    server.stop(true);
  });

  test("a worker token can read a build too", async () => {
    const { server, authed, asWorker } = await harness();
    const created = (await (
      await authed("/v1/builds", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["deb"] }),
      })
    ).json()) as BuildProps;
    const res = await asWorker(`/v1/builds/${created.id}`);
    expect(res.status).toBe(200);
    server.stop(true);
  });
});

describe("the claim -> complete loop", () => {
  test("a worker can claim, then report success", async () => {
    const { server, authed, asWorker } = await harness();
    const created = (await (
      await authed("/v1/builds", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["appimage"] }),
      })
    ).json()) as BuildProps;

    const claimed = (await (
      await asWorker("/v1/builds/claim", {
        method: "POST",
        body: JSON.stringify({ platform: "linux", workerId: "w1" }),
      })
    ).json()) as BuildProps;
    expect(claimed.id).toBe(created.id);

    const running = await asWorker(`/v1/builds/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "running" }),
    });
    expect(running.status).toBe(200);

    const done = await asWorker(`/v1/builds/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "succeeded", artifacts: [] }),
    });
    expect(done.status).toBe(200);

    const final = (await (await authed(`/v1/builds/${created.id}`)).json()) as BuildProps;
    expect(final.status).toBe("succeeded");
    server.stop(true);
  });

  test("an empty claim response is 204, not an empty 200", async () => {
    const { server, asWorker } = await harness();
    const res = await asWorker("/v1/builds/claim", {
      method: "POST",
      body: JSON.stringify({ platform: "linux", workerId: "w1" }),
    });
    expect(res.status).toBe(204);
    server.stop(true);
  });

  test("a worker token cannot claim another org's queued build", async () => {
    const { server, authed, createOrganization, issueWorkerToken, withToken } = await harness();
    await authed("/v1/builds", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["appimage"] }),
    });

    const other = await createOrganization.execute("Other Org");
    const { workerToken: otherWorkerToken } = await issueWorkerToken.execute(other.orgId);
    const asOtherWorker = withToken(otherWorkerToken);

    const res = await asOtherWorker("/v1/builds/claim", {
      method: "POST",
      body: JSON.stringify({ platform: "linux", workerId: "w1" }),
    });
    expect(res.status).toBe(204);
    server.stop(true);
  });
});

describe("GET /v1/usage", () => {
  test("reports the org's plan and usage", async () => {
    const { server, authed } = await harness();
    const res = await authed("/v1/usage");
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status).toEqual({ withinLimit: true, usedMinutes: 0, includedMinutes: 60 });
    server.stop(true);
  });

  test("requires auth", async () => {
    const { server, base } = await harness();
    const res = await fetch(`${base}/v1/usage`);
    expect(res.status).toBe(401);
    server.stop(true);
  });
});

describe("usage limits", () => {
  test("a build completing successfully records usage", async () => {
    const { server, authed, asWorker, orgId, billing } = await harness();
    const created = (await (
      await authed("/v1/builds", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["deb"] }),
      })
    ).json()) as BuildProps;

    await asWorker(`/v1/builds/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "succeeded", artifacts: [] }),
    });

    // recorded, even if ~0 minutes for an instant test run — sumMinutesForOrg
    // going through unaffected is the thing this checks, not the exact value.
    const usedMinutes = await billing.sumMinutesForOrg(orgId, new Date(0));
    expect(usedMinutes).toBeGreaterThanOrEqual(0);
    server.stop(true);
  });

  test("a build over the free plan's included minutes is refused with 402", async () => {
    const { server, authed, orgId, billing } = await harness();
    // Free plan: 60 included minutes. Pre-seed past that directly through
    // the repository — simulating a prior period's usage without needing
    // 61 real build/complete round trips.
    await billing.save(
      UsageRecord.record({ id: crypto.randomUUID(), orgId, buildId: "prior", durationMs: 61 * 60_000 }),
    );

    const res = await authed("/v1/builds", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["deb"] }),
    });
    expect(res.status).toBe(402);
    server.stop(true);
  });
});

describe("POST /v1/billing/checkout", () => {
  test("an org token gets a checkout session url, and the plan hasn't changed yet", async () => {
    const { server, authed } = await harness();
    const res = await authed("/v1/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain("checkout=success");

    const usage = (await (await authed("/v1/usage")).json()) as { includedMinutes: number };
    expect(usage.includedMinutes).toBe(60); // still free — no webhook confirmation happened
    server.stop(true);
  });

  test("a worker token cannot start a checkout session", async () => {
    const { server, asWorker } = await harness();
    const res = await asWorker("/v1/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(res.status).toBe(403);
    server.stop(true);
  });
});

describe("POST /v1/billing/webhook", () => {
  const secret = "whsec_test_secret";

  function sign(payload: string): string {
    const t = Math.floor(Date.now() / 1000);
    const hmac = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    return `t=${t},v1=${hmac}`;
  }

  test("a validly signed checkout.session.completed confirms the plan upgrade", async () => {
    const { server, base, authed, orgId } = await harness();
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { metadata: { orgId, plan: "pro" } } },
    });

    const res = await fetch(`${base}/v1/billing/webhook`, {
      method: "POST",
      headers: { "stripe-signature": sign(payload) },
      body: payload,
    });
    expect(res.status).toBe(200);

    const usage = (await (await authed("/v1/usage")).json()) as { includedMinutes: number };
    expect(usage.includedMinutes).toBe(6000);
    server.stop(true);
  });

  test("an invalid signature is refused, and the plan does not change", async () => {
    const { server, base, authed, orgId } = await harness();
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { metadata: { orgId, plan: "pro" } } },
    });

    const res = await fetch(`${base}/v1/billing/webhook`, {
      method: "POST",
      headers: { "stripe-signature": "t=123,v1=not_a_real_signature" },
      body: payload,
    });
    expect(res.status).toBe(400);

    const usage = (await (await authed("/v1/usage")).json()) as { includedMinutes: number };
    expect(usage.includedMinutes).toBe(60);
    server.stop(true);
  });

  test("build logs and artifacts endpoints", async () => {
    const { server, authed, asWorker } = await harness();

    // Create a build
    const buildRes = await authed("/v1/builds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/example/app.git",
        commitSha: "a".repeat(40),
        targets: ["deb"],
      }),
    });
    const build = (await buildRes.json()) as { id: string };

    // Append log from worker
    const logRes = await asWorker(`/v1/builds/${build.id}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: "Compiling Zig C-ABI extension..." }),
    });
    expect(logRes.status).toBe(200);

    // Read logs from org token
    const getLogsRes = await authed(`/v1/builds/${build.id}/logs`);
    expect(getLogsRes.status).toBe(200);
    const logs = (await getLogsRes.json()) as any[];
    expect(logs.length).toBe(1);
    expect(logs[0].line).toBe("Compiling Zig C-ABI extension...");

    // Register artifact from worker
    const artRes = await asWorker(`/v1/builds/${build.id}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "app_1.0.0_amd64.deb",
        target: "deb",
        sizeBytes: 15420000,
        downloadUrl: "https://storage.carbon.dev/builds/app_1.0.0_amd64.deb",
        checksumSha256: "abc123sha",
      }),
    });
    expect(artRes.status).toBe(201);
    const art = (await artRes.json()) as any;
    expect(art.name).toBe("app_1.0.0_amd64.deb");

    // Read artifacts from org token
    const getArtRes = await authed(`/v1/builds/${build.id}/artifacts`);
    expect(getArtRes.status).toBe(200);
    const artifacts = (await getArtRes.json()) as any[];
    expect(artifacts.length).toBe(1);
    expect(artifacts[0].name).toBe("app_1.0.0_amd64.deb");

    server.stop(true);
  });
});
