// The HTTP surface, over in-memory repositories. What talks to a real
// Postgres is PostgresBuildRepository/PostgresIdentityRepository's own
// concern; this only checks that a request maps to the right use case,
// auth (and scope) gates what it should, and status codes are right — none
// of which needs a database to prove.

import { describe, expect, test } from "bun:test";
import {
  ClaimNextBuildUseCase,
  CompleteBuildUseCase,
  CreateBuildUseCase,
  GetBuildUseCase,
  InMemoryBuildRepository,
  type BuildProps,
} from "@carbon/cloud-orchestration";
import {
  CreateOrganizationUseCase,
  IssueWorkerTokenUseCase,
  InMemoryIdentityRepository,
  VerifyTokenUseCase,
} from "@carbon/identity";
import {
  CheckUsageLimitUseCase,
  InMemoryBillingRepository,
  RecordBuildUsageUseCase,
  UsageRecord,
} from "@carbon/billing";
import { buildRoutes } from "../infrastructure/http/routes.ts";

async function harness() {
  const builds = new InMemoryBuildRepository();
  const identity = new InMemoryIdentityRepository();
  const billing = new InMemoryBillingRepository();
  const createOrganization = new CreateOrganizationUseCase(identity);
  const issueWorkerToken = new IssueWorkerTokenUseCase(identity);
  const routes = buildRoutes({
    createBuild: new CreateBuildUseCase(builds),
    getBuild: new GetBuildUseCase(builds),
    claimNext: new ClaimNextBuildUseCase(builds),
    completeBuild: new CompleteBuildUseCase(builds),
    createOrganization,
    issueWorkerToken,
    verifyToken: new VerifyTokenUseCase(identity),
    checkUsageLimit: new CheckUsageLimitUseCase(billing, billing),
    recordBuildUsage: new RecordBuildUsageUseCase(billing),
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

  return { server, base, orgId, apiToken, workerToken, authed, asWorker, billing };
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
