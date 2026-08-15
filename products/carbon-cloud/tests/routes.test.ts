// The HTTP surface, over an in-memory BuildRepository. What talks to a real
// Postgres is PostgresBuildRepository's own concern (cloud-orchestration);
// this only checks that a request maps to the right use case and status
// code, which doesn't need a database to prove.

import { describe, expect, test } from "bun:test";
import {
  ClaimNextBuildUseCase,
  CompleteBuildUseCase,
  CreateBuildUseCase,
  GetBuildUseCase,
  InMemoryBuildRepository,
  type BuildProps,
} from "@carbon/cloud-orchestration";
import { buildRoutes } from "../infrastructure/http/routes.ts";

function harness() {
  const builds = new InMemoryBuildRepository();
  const routes = buildRoutes({
    createBuild: new CreateBuildUseCase(builds),
    getBuild: new GetBuildUseCase(builds),
    claimNext: new ClaimNextBuildUseCase(builds),
    completeBuild: new CompleteBuildUseCase(builds),
  });
  const server = Bun.serve({ port: 0, routes, fetch: () => new Response("not found", { status: 404 }) });
  return { server, base: `http://localhost:${server.port}` };
}

describe("POST /v1/builds", () => {
  test("creates a queued build", async () => {
    const { server, base } = harness();
    const res = await fetch(`${base}/v1/builds`, {
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
    const { server, base } = harness();
    const res = await fetch(`${base}/v1/builds/does-not-exist`);
    expect(res.status).toBe(404);
    server.stop(true);
  });
});

describe("the claim -> complete loop", () => {
  test("a worker can claim, then report success", async () => {
    const { server, base } = harness();
    const created = (await (
      await fetch(`${base}/v1/builds`, {
        method: "POST",
        body: JSON.stringify({ repoUrl: "r", commitSha: "c", targets: ["appimage"] }),
      })
    ).json()) as BuildProps;

    const claimed = (await (
      await fetch(`${base}/v1/builds/claim`, {
        method: "POST",
        body: JSON.stringify({ platform: "linux", workerId: "w1" }),
      })
    ).json()) as BuildProps;
    expect(claimed.id).toBe(created.id);

    const running = await fetch(`${base}/v1/builds/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "running" }),
    });
    expect(running.status).toBe(200);

    const done = await fetch(`${base}/v1/builds/${created.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ outcome: "succeeded", artifacts: [] }),
    });
    expect(done.status).toBe(200);

    const final = (await (await fetch(`${base}/v1/builds/${created.id}`)).json()) as BuildProps;
    expect(final.status).toBe("succeeded");
    server.stop(true);
  });

  test("an empty claim response is 204, not an empty 200", async () => {
    const { server, base } = harness();
    const res = await fetch(`${base}/v1/builds/claim`, {
      method: "POST",
      body: JSON.stringify({ platform: "linux", workerId: "w1" }),
    });
    expect(res.status).toBe(204);
    server.stop(true);
  });
});
