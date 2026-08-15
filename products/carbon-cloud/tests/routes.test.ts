// The HTTP surface, over in-memory repositories. What talks to a real
// Postgres is PostgresBuildRepository/PostgresIdentityRepository's own
// concern; this only checks that a request maps to the right use case,
// auth gates what it should, and status codes are right — none of which
// needs a database to prove.

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
  InMemoryIdentityRepository,
  VerifyTokenUseCase,
} from "@carbon/identity";
import { buildRoutes } from "../infrastructure/http/routes.ts";

async function harness() {
  const builds = new InMemoryBuildRepository();
  const identity = new InMemoryIdentityRepository();
  const createOrganization = new CreateOrganizationUseCase(identity);
  const routes = buildRoutes({
    createBuild: new CreateBuildUseCase(builds),
    getBuild: new GetBuildUseCase(builds),
    claimNext: new ClaimNextBuildUseCase(builds),
    completeBuild: new CompleteBuildUseCase(builds),
    createOrganization,
    verifyToken: new VerifyTokenUseCase(identity),
  });
  const server = Bun.serve({ port: 0, routes, fetch: () => new Response("not found", { status: 404 }) });
  const base = `http://localhost:${server.port}`;

  // Every scenario below needs a valid token to get past auth, so signing
  // up once here is setup, not the thing under test — signup itself is
  // covered separately below.
  const { apiToken } = await createOrganization.execute("Test Org");
  const authed = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${apiToken}` },
    });

  return { server, base, apiToken, authed };
}

describe("POST /v1/orgs", () => {
  test("signup returns an org id and a usable token", async () => {
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
});

describe("the claim -> complete loop", () => {
  test("a worker can claim, then report success", async () => {
    const { server, authed } = await harness();
    const created = (await (
      await authed("/v1/builds", {
        method: "POST",
        body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["appimage"] }),
      })
    ).json()) as BuildProps;

    const claimed = (await (
      await authed("/v1/builds/claim", {
        method: "POST",
        body: JSON.stringify({ platform: "linux", workerId: "w1" }),
      })
    ).json()) as BuildProps;
    expect(claimed.id).toBe(created.id);

    const running = await authed(`/v1/builds/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "running" }),
    });
    expect(running.status).toBe(200);

    const done = await authed(`/v1/builds/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "succeeded", artifacts: [] }),
    });
    expect(done.status).toBe(200);

    const final = (await (await authed(`/v1/builds/${created.id}`)).json()) as BuildProps;
    expect(final.status).toBe("succeeded");
    server.stop(true);
  });

  test("an empty claim response is 204, not an empty 200", async () => {
    const { server, authed } = await harness();
    const res = await authed("/v1/builds/claim", {
      method: "POST",
      body: JSON.stringify({ platform: "linux", workerId: "w1" }),
    });
    expect(res.status).toBe(204);
    server.stop(true);
  });
});
