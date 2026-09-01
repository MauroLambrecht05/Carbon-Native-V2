// RunNextJobUseCase's orchestration, over fakes for every port — proving
// the claim -> compile -> package each target -> upload -> report sequence
// and its error handling, without a real git checkout, toolchain or S3.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CarbonConfig } from "@carbon/contracts/app";
import type { BuildArtifact, BuildProps } from "@carbon/orchestration";
import {
  RunNextJobUseCase,
  type ArtifactUploader,
  type ControlPlaneClient,
  type LocalPipeline,
  type RepoFetcher,
} from "../index.ts";

function queuedBuild(overrides: Partial<BuildProps> = {}): BuildProps {
  const now = new Date();
  return {
    id: "build_1",
    orgId: "org_1",
    repoUrl: "https://example.com/demo.git",
    commitSha: "abc123",
    targets: ["deb"],
    status: "queued",
    workerId: null,
    artifacts: [],
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeControlPlane implements ControlPlaneClient {
  next: BuildProps | null = null;
  readonly running: string[] = [];
  succeeded: { buildId: string; artifacts: readonly BuildArtifact[] } | null = null;
  failed: { buildId: string; error: string } | null = null;

  async claimNext(): Promise<BuildProps | null> {
    return this.next;
  }
  async reportRunning(buildId: string): Promise<void> {
    this.running.push(buildId);
  }
  async reportSucceeded(buildId: string, artifacts: readonly BuildArtifact[]): Promise<void> {
    this.succeeded = { buildId, artifacts };
  }
  async reportFailed(buildId: string, error: string): Promise<void> {
    this.failed = { buildId, error };
  }
}

class FakeRepoFetcher implements RepoFetcher {
  calls: Array<{ repoUrl: string; commitSha: string; destDir: string }> = [];
  shouldFail = false;
  async fetch(repoUrl: string, commitSha: string, destDir: string): Promise<void> {
    this.calls.push({ repoUrl, commitSha, destDir });
    if (this.shouldFail) throw new Error("clone failed");
  }
}

class FakePipeline implements LocalPipeline {
  packagedTargets: string[] = [];
  async compile(): Promise<{ binaryPath: string }> {
    return { binaryPath: "/build/carbon-mini" };
  }
  async packageTarget(_config: CarbonConfig, _binaryPath: string, target: string) {
    this.packagedTargets.push(target);
    return { target: target as never, path: `/out/${target}/app.${target}`, sha256: "deadbeef" };
  }
}

class FakeUploader implements ArtifactUploader {
  uploaded: string[] = [];
  async upload(localPath: string) {
    this.uploaded.push(localPath);
    return { url: `https://cdn.example.com/${localPath}` };
  }
}

// loadCarbonConfig reads a real carbon.toml off disk, which none of these
// tests have — RunNextJobUseCase calls @carbon/workspace's loadCarbonConfig
// directly rather than through a port (it's a pure read, not something a
// job's outcome should vary on), so the tests mock the module instead of
// adding a port for a single call.
import { mock } from "bun:test";
mock.module("@carbon/workspace", () => ({
  loadCarbonConfig: async () => ({
    app: { name: "demo", version: "1.0.0" },
    runtime: { backend: "mini", bytecode: false, image: false, audio: false, network: true, svg: true },
    raw: {},
  }),
}));

function harness() {
  const controlPlane = new FakeControlPlane();
  const repos = new FakeRepoFetcher();
  const pipeline = new FakePipeline();
  const uploader = new FakeUploader();
  const useCase = new RunNextJobUseCase(controlPlane, repos, pipeline, uploader, "worker-1", "linux", "/work");
  return { controlPlane, repos, pipeline, uploader, useCase };
}

describe("idle", () => {
  test("nothing queued is idle, not an error", async () => {
    const { useCase } = harness();
    expect(await useCase.execute()).toBe("idle");
  });
});

describe("a successful job", () => {
  test("reports running, packages every target, uploads, reports succeeded", async () => {
    const h = harness();
    h.controlPlane.next = queuedBuild({ targets: ["deb", "appimage"] });

    const outcome = await h.useCase.execute();

    expect(outcome).toBe("succeeded");
    expect(h.controlPlane.running).toEqual(["build_1"]);
    expect(h.repos.calls).toEqual([
      { repoUrl: "https://example.com/demo.git", commitSha: "abc123", destDir: join("/work", "build_1") },
    ]);
    expect(h.pipeline.packagedTargets).toEqual(["deb", "appimage"]);
    expect(h.uploader.uploaded).toHaveLength(2);
    expect(h.controlPlane.succeeded?.buildId).toBe("build_1");
    expect(h.controlPlane.succeeded?.artifacts).toHaveLength(2);
    expect(h.controlPlane.succeeded?.artifacts[0]).toMatchObject({ target: "deb", sha256: "deadbeef" });
  });
});

describe("a failed job", () => {
  test("a checkout failure is reported, not thrown", async () => {
    const h = harness();
    h.controlPlane.next = queuedBuild();
    h.repos.shouldFail = true;

    const outcome = await h.useCase.execute();

    expect(outcome).toBe("failed");
    expect(h.controlPlane.failed).toEqual({ buildId: "build_1", error: "clone failed" });
    expect(h.controlPlane.succeeded).toBeNull();
    // running was still reported before the checkout was attempted — the
    // control plane should never show "queued" for a build a worker is
    // actively (if briefly) working on.
    expect(h.controlPlane.running).toEqual(["build_1"]);
  });
});
