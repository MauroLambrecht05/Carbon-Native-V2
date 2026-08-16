import { describe, expect, test } from "bun:test";
import {
  ClaimNextBuildUseCase,
  CompleteBuildUseCase,
  CreateBuildUseCase,
  GetBuildUseCase,
  ListOrgBuildsUseCase,
  InMemoryBuildRepository,
  BuildNotFoundError,
  InvalidTransitionError,
} from "../index.ts";

function harness() {
  const builds = new InMemoryBuildRepository();
  return {
    builds,
    create: new CreateBuildUseCase(builds),
    claim: new ClaimNextBuildUseCase(builds),
    complete: new CompleteBuildUseCase(builds),
    get: new GetBuildUseCase(builds),
    list: new ListOrgBuildsUseCase(builds),
  };
}

describe("the lifecycle", () => {
  test("a build queues, gets claimed, runs, and succeeds", async () => {
    const h = harness();
    const build = await h.create.execute({
      orgId: "org_1",
      repoUrl: "https://example.com/demo.git",
      commitSha: "abc123",
      targets: ["deb"],
    });
    expect(build.status).toBe("queued");

    const claimed = await h.claim.execute({ platform: "linux", workerId: "worker-1" });
    expect(claimed?.id).toBe(build.id);
    expect(claimed?.status).toBe("claimed");

    await h.complete.execute({ buildId: build.id, outcome: "running" });
    expect((await h.get.execute(build.id)).status).toBe("running");

    await h.complete.execute({
      buildId: build.id,
      outcome: "succeeded",
      artifacts: [{ target: "deb", path: "/out/demo.deb", sha256: "deadbeef", url: "https://cdn/demo.deb" }],
    });
    const done = await h.get.execute(build.id);
    expect(done.status).toBe("succeeded");
    expect(done.toProps().artifacts).toHaveLength(1);
  });

  test("a claimed build can fail without ever running", async () => {
    const h = harness();
    const build = await h.create.execute({
      orgId: "org_1", repoUrl: "https://example.com/demo.git", commitSha: "abc", targets: ["deb"],
    });
    await h.claim.execute({ platform: "linux", workerId: "w1" });
    await h.complete.execute({ buildId: build.id, outcome: "failed", error: "clone failed" });
    const failed = await h.get.execute(build.id);
    expect(failed.status).toBe("failed");
    expect(failed.toProps().error).toBe("clone failed");
  });
});

describe("claiming", () => {
  test("only the oldest queued build for the platform is claimed", async () => {
    const h = harness();
    const first = await h.create.execute({
      orgId: "o", repoUrl: "r", commitSha: "1", targets: ["deb"],
    });
    await new Promise((r) => setTimeout(r, 2));
    await h.create.execute({ orgId: "o", repoUrl: "r", commitSha: "2", targets: ["deb"] });

    const claimed = await h.claim.execute({ platform: "linux", workerId: "w1" });
    expect(claimed?.id).toBe(first.id);
  });

  test("a build queued for a Windows target is invisible to a Linux worker", async () => {
    const h = harness();
    await h.create.execute({ orgId: "o", repoUrl: "r", commitSha: "1", targets: ["nsis"] });
    const claimed = await h.claim.execute({ platform: "linux", workerId: "w1" });
    expect(claimed).toBeNull();
  });

  test("nothing queued means null, not an error", async () => {
    const h = harness();
    expect(await h.claim.execute({ platform: "linux", workerId: "w1" })).toBeNull();
  });
});

describe("refusals", () => {
  test("completing an unknown build is refused", async () => {
    const h = harness();
    await expect(
      h.complete.execute({ buildId: "nope", outcome: "running" }),
    ).rejects.toThrow(BuildNotFoundError);
  });

  test("a queued build cannot succeed without being claimed first", async () => {
    const h = harness();
    const build = await h.create.execute({
      orgId: "o", repoUrl: "r", commitSha: "1", targets: ["deb"],
    });
    await expect(
      h.complete.execute({ buildId: build.id, outcome: "succeeded", artifacts: [] }),
    ).rejects.toThrow(InvalidTransitionError);
  });

  test("a succeeded build cannot be completed again", async () => {
    const h = harness();
    const build = await h.create.execute({
      orgId: "o", repoUrl: "r", commitSha: "1", targets: ["deb"],
    });
    await h.claim.execute({ platform: "linux", workerId: "w1" });
    await h.complete.execute({ buildId: build.id, outcome: "running" });
    await h.complete.execute({ buildId: build.id, outcome: "succeeded", artifacts: [] });
    await expect(
      h.complete.execute({ buildId: build.id, outcome: "succeeded", artifacts: [] }),
    ).rejects.toThrow(InvalidTransitionError);
  });
});

describe("listing", () => {
  test("most recent first, scoped to the org, capped by limit", async () => {
    const h = harness();
    await h.create.execute({ orgId: "o1", repoUrl: "r", commitSha: "1", targets: ["deb"] });
    await new Promise((r) => setTimeout(r, 2));
    const second = await h.create.execute({ orgId: "o1", repoUrl: "r", commitSha: "2", targets: ["deb"] });
    await h.create.execute({ orgId: "o2", repoUrl: "r", commitSha: "x", targets: ["deb"] });

    const list = await h.list.execute("o1", 1);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(second.id);
  });

  test("an org with no builds gets an empty list, not an error", async () => {
    const h = harness();
    expect(await h.list.execute("nobody")).toEqual([]);
  });
});
