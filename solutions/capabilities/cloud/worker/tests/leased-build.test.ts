// RunLeasedBuildUseCase and its adapters, over fakes for Cloud, git and the
// pipeline: the cases a real checkout cannot produce on demand (a wrong
// commit, a workspace that will not erase, a lease lost mid-build), plus the
// pieces that need no server at all. The whole path against the real worker
// API is in products/carbon-cloud/tests/platform.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildArtifactDeclare, WorkerBuildComplete, WorkerBuildInput, WorkerLeaseOffer } from "@carbon/contracts/platform";
import {
  BuildFailure, CarbonBuildPipeline, DisposableWorkspaces, HttpBuildProtocol, LeaseLostError, RunLeasedBuildUseCase, WorkerProtocolError, digestDependencyLocks, redactor,
  type BuildPipeline, type BuildProtocol, type HeldBuildLease, type SourceCheckout, type WorkspaceProvider,
} from "../index.ts";

const COMMIT = "a".repeat(40); const ID = "11111111-1111-4111-8111-111111111111";
const scope = { orgId: ID, projectId: ID, environmentId: ID };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

class FakeCloud implements BuildProtocol {
  offered = true; cancelled = false; lost = false; rejectCompletion = false;
  readonly logs: string[] = []; readonly declared: BuildArtifactDeclare[] = []; readonly completed: WorkerBuildComplete[] = [];
  async claim(): Promise<WorkerLeaseOffer> {
    if (!this.offered) return { state: "none" };
    return { state: "leased", leaseToken: "wl_" + "t".repeat(43), heartbeatSeconds: 30, lease: { id: ID, workerId: ID, scope, purpose: "build", subjectId: ID, attempt: 1, secretNames: ["SIGNING_KEY"], state: "claimed",
      expiresAt: "2026-10-10T08:00:00Z", deadlineAt: "2026-10-10T09:00:00Z", createdAt: "2026-10-10T07:00:00Z" } } as unknown as WorkerLeaseOffer;
  }
  private held() { if (this.lost) throw new LeaseLostError(); }
  async heartbeat() { this.held(); return { cancelled: this.cancelled }; }
  async input(): Promise<WorkerBuildInput> {
    this.held();
    return { buildId: ID, scope, attempt: 1, nextLogSequence: 4, sourceDigest: sha256("source"),
      source: { repositoryUrl: "https://github.com/example/app.git", commitSha: COMMIT, targets: ["nsis"], secretNames: ["SIGNING_KEY"], platform: "windows" } };
  }
  async secrets() { this.held(); return [{ name: "SIGNING_KEY", version: 1, value: "top-secret-value" }]; }
  async appendLog(_lease: HeldBuildLease, sequence: number, text: string) { this.held(); this.logs.push(`${sequence}:${text}`); }
  async declareArtifact(_lease: HeldBuildLease, artifact: BuildArtifactDeclare) { this.held(); this.declared.push(artifact); }
  async complete(_lease: HeldBuildLease, result: WorkerBuildComplete) {
    this.held(); if (this.rejectCompletion && result.outcome === "succeeded") throw new WorkerProtocolError(409, "conflict");
    this.completed.push(result);
  }
}

function fixture(overrides: { resolvedCommit?: string; lockfile?: boolean; eraseFails?: boolean; pipeline?: BuildPipeline } = {}) {
  const root = mkdtempSync(join(tmpdir(), "carbon-leased-build-")); const cloud = new FakeCloud(); const uploads: string[] = [];
  const real = new DisposableWorkspaces(join(root, "work")); let erasures = 0;
  const workspaces: WorkspaceProvider = { reset: () => real.reset(), async create(buildId, attempt) {
    const workspace = await real.create(buildId, attempt);
    return { directory: workspace.directory, erase: async () => { erasures++; if (overrides.eraseFails) throw new Error("file in use"); await workspace.erase(); } };
  } };
  const source: SourceCheckout = { async checkout(_url, _commit, directory) {
    mkdirSync(directory); if (overrides.lockfile !== false) writeFileSync(join(directory, "bun.lock"), "lock");
    return { resolvedCommit: overrides.resolvedCommit ?? COMMIT, tool: { name: "git", version: "2.45.0" } };
  } };
  const pipeline: BuildPipeline = overrides.pipeline ?? { async run(input) {
    const path = join(input.outputDirectory, "setup.exe"); writeFileSync(path, "installer"); input.log(`key ${input.secrets.SIGNING_KEY}`);
    return { outputs: [{ target: "nsis", path }], tools: [{ name: "bun", version: "1.3.10" }], configurationDigest: null };
  } };
  const run = new RunLeasedBuildUseCase(cloud, source, workspaces, pipeline, { async upload(_path, key) { uploads.push(key); return { url: key }; } }, { heartbeatMs: 5 });
  return { root, cloud, uploads, run, work: join(root, "work"), erasures: () => erasures, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("RunLeasedBuildUseCase", () => {
  test("idle when Cloud offers nothing", async () => {
    const f = fixture(); f.cloud.offered = false;
    try { expect(await f.run.execute()).toBe("idle"); expect(f.cloud.completed).toEqual([]); } finally { f.cleanup(); }
  });

  test("a build reports its materials only after the workspace is gone", async () => {
    const f = fixture();
    try {
      expect(await f.run.execute()).toBe("succeeded");
      expect(f.cloud.declared).toEqual([{ target: "nsis", objectKey: `artifacts/${ID}/1/nsis/setup.exe`, sizeBytes: 9, sha256: sha256("installer") }]);
      expect(f.uploads).toEqual([`artifacts/${ID}/1/nsis/setup.exe`]);
      expect(f.cloud.completed).toEqual([{ outcome: "succeeded", materials: { resolvedCommit: COMMIT, dependencyLockDigest: sha256(`bun.lock\0${sha256("lock")}\n`), configurationDigest: null,
        tools: [{ name: "bun", version: "1.3.10" }, { name: "git", version: "2.45.0" }], workspaceErased: true } }]);
      expect(readdirSync(f.work)).toEqual([]);
      // Logs continue from the sequence Cloud gave and never carry the secret.
      expect(f.cloud.logs[0]!.startsWith("4:")).toBe(true); const text = f.cloud.logs.join("");
      expect(text).toContain("key [redacted]"); expect(text).not.toContain("top-secret-value");
    } finally { f.cleanup(); }
  });

  test("a checkout that is not the requested commit fails the build before anything runs", async () => {
    let ran = false; const f = fixture({ resolvedCommit: "b".repeat(40), pipeline: { async run() { ran = true; throw new Error("unreachable"); } } });
    try {
      expect(await f.run.execute()).toBe("failed"); expect(ran).toBe(false);
      expect(f.cloud.completed).toEqual([{ outcome: "failed", errorCategory: "source.commit_mismatch" }]); expect(readdirSync(f.work)).toEqual([]);
    } finally { f.cleanup(); }
  });

  test("a project without a lockfile is refused", async () => {
    const f = fixture({ lockfile: false });
    try { expect(await f.run.execute()).toBe("failed"); expect(f.cloud.completed).toEqual([{ outcome: "failed", errorCategory: "dependencies.unlocked" }]); } finally { f.cleanup(); }
  });

  test("a workspace that cannot be erased is never reported as a success", async () => {
    const f = fixture({ eraseFails: true });
    try {
      expect(await f.run.execute()).toBe("failed");
      expect(f.cloud.completed).toEqual([{ outcome: "failed", errorCategory: "workspace.not_erased" }]);
      // The next run refuses nothing silently: reset() clears the leftovers before any new claim.
      expect(readdirSync(f.work)).toHaveLength(1); f.cloud.offered = false;
      expect(await f.run.execute()).toBe("idle"); expect(readdirSync(f.work)).toEqual([]);
    } finally { f.cleanup(); }
  });

  test("pipeline failures keep their category and unknown errors do not leak their text", async () => {
    for (const [error, category] of [[new BuildFailure("compile.failed", "x"), "compile.failed"], [new Error("C:\\secret\\path"), "build.failed"], [new BuildFailure("Not A Category", "x"), "worker.internal"]] as const) {
      const f = fixture({ pipeline: { async run() { throw error; } } });
      try {
        expect(await f.run.execute()).toBe("failed"); expect(f.cloud.completed).toEqual([{ outcome: "failed", errorCategory: category }]);
        expect(f.cloud.logs.join("")).not.toContain("secret"); expect(readdirSync(f.work)).toEqual([]);
      } finally { f.cleanup(); }
    }
  });

  test("a missing installer and a refused completion fail the build", async () => {
    const missing = fixture({ pipeline: { async run() { return { outputs: [], tools: [], configurationDigest: null }; } } });
    try { expect(await missing.run.execute()).toBe("failed"); expect(missing.cloud.completed).toEqual([{ outcome: "failed", errorCategory: "package.missing_output" }]); } finally { missing.cleanup(); }
    const refused = fixture(); refused.cloud.rejectCompletion = true;
    try { expect(await refused.run.execute()).toBe("failed"); expect(refused.cloud.completed).toEqual([{ outcome: "failed", errorCategory: "completion.rejected" }]); } finally { refused.cleanup(); }
  });

  test("cancellation and a lost lease stop the work, erase the workspace and report nothing", async () => {
    for (const reason of ["cancelled", "lost"] as const) {
      let f!: ReturnType<typeof fixture>;
      f = fixture({ pipeline: { async run(input) {
        if (reason === "cancelled") f.cloud.cancelled = true; else f.cloud.lost = true;
        await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve()));
        const path = join(input.outputDirectory, "setup.exe"); writeFileSync(path, "installer");
        return { outputs: [{ target: "nsis", path }], tools: [], configurationDigest: null };
      } } });
      try {
        expect(await f.run.execute()).toBe(reason);
        expect(f.cloud.completed).toEqual([]); expect(f.cloud.declared).toEqual([]); expect(f.uploads).toEqual([]); expect(readdirSync(f.work)).toEqual([]);
      } finally { f.cleanup(); }
    }
  });
});

describe("worker building blocks", () => {
  test("redaction covers whole values, each line of a multi-line value, and values split across writes", () => {
    const key = "-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG\n9w0BAQEFAASCBKcwggSj\n-----END KEY-----";
    const redact = redactor([key, "hunter22", "", "hunter22-extended"]);
    expect(redact("password=hunter22 other=hunter22-extended")).toBe("password=[redacted] other=[redacted]");
    expect(redact("line: MIIEvQIBADANBgkqhkiG")).toBe("line: [redacted]"); expect(redact(key)).toBe("[redacted]");
    expect(redact("nothing to hide")).toBe("nothing to hide");
  });

  test("the lockfile digest changes with any lockfile and is absent without bun's", () => {
    const directory = mkdtempSync(join(tmpdir(), "carbon-locks-"));
    try {
      expect(digestDependencyLocks(directory)).toBeNull(); writeFileSync(join(directory, "Cargo.lock"), "cargo"); expect(digestDependencyLocks(directory)).toBeNull();
      writeFileSync(join(directory, "bun.lock"), "one"); const first = digestDependencyLocks(directory)!; expect(first).toMatch(/^[a-f0-9]{64}$/);
      writeFileSync(join(directory, "Cargo.lock"), "cargo2"); const second = digestDependencyLocks(directory)!; expect(second).not.toBe(first);
      writeFileSync(join(directory, "bun.lock"), "two"); expect(digestDependencyLocks(directory)).not.toBe(second);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("a workspace is new, single-use and fully removed", async () => {
    const root = mkdtempSync(join(tmpdir(), "carbon-workspaces-")); const workspaces = new DisposableWorkspaces(join(root, "work"));
    try {
      await workspaces.reset(); const workspace = await workspaces.create(ID, 1);
      mkdirSync(join(workspace.directory, "source", "nested"), { recursive: true }); writeFileSync(join(workspace.directory, "source", "nested", "file"), "x", { mode: 0o444 });
      // The same attempt cannot get the directory again while it exists.
      await expect(workspaces.create(ID, 1)).rejects.toThrow();
      await expect(workspaces.create("../escape", 1)).rejects.toThrow("Invalid workspace name");
      await workspace.erase(); expect(existsSync(workspace.directory)).toBe(false);
      await workspaces.create(ID, 2); await workspaces.reset(); expect(readdirSync(join(root, "work"))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("the HTTP client sends the credential and lease token, and reads a conflict on a lease call as a lost lease", async () => {
    const calls: { url: string; headers: Headers; body: string | null }[] = []; let status = 200; let payload: unknown = { state: "none" };
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: (init?.body as string | undefined) ?? null });
      return Response.json(status === 200 ? payload : { error: { code: "conflict", message: "secret detail" } }, { status });
    }) as typeof fetch;
    const protocol = new HttpBuildProtocol("https://cloud.example.test/", "wc_" + "c".repeat(43), transport); const lease = { leaseId: ID, leaseToken: "wl_" + "t".repeat(43) };
    expect(await protocol.claim()).toEqual({ state: "none" });
    expect(calls[0]!.url).toBe("https://cloud.example.test/worker/v1/leases/claim"); expect(calls[0]!.headers.get("authorization")).toBe("Bearer wc_" + "c".repeat(43)); expect(calls[0]!.headers.has("x-carbon-lease-token")).toBe(false);
    payload = { nextLogSequence: 2 }; await protocol.appendLog(lease, 1, "hello");
    expect(calls[1]!.url).toBe(`https://cloud.example.test/worker/v1/leases/${ID}/build/logs`); expect(calls[1]!.headers.get("x-carbon-lease-token")).toBe(lease.leaseToken); expect(JSON.parse(calls[1]!.body!)).toEqual({ sequence: 1, text: "hello" });
    status = 409;
    await expect(protocol.appendLog(lease, 2, "late")).rejects.toBeInstanceOf(LeaseLostError); await expect(protocol.heartbeat(lease)).rejects.toBeInstanceOf(LeaseLostError);
    // A refused completion or declaration is a verdict on the build, and its text never includes the response body.
    const refused = await protocol.complete(lease, { outcome: "failed", errorCategory: "compile.failed" }).catch(error => error);
    expect(refused).toBeInstanceOf(WorkerProtocolError); expect(String(refused.message)).not.toContain("secret detail");
    status = 401; await expect(protocol.claim()).rejects.toMatchObject({ status: 401, code: "conflict" });
  });

  test("the Carbon pipeline refuses targets the platform cannot produce before touching the project", async () => {
    const pipeline = new CarbonBuildPipeline(() => { throw new Error("must not be constructed"); });
    const run = { sourceDirectory: "missing", outputDirectory: "missing", scratchDirectory: "missing", secrets: {}, log() {}, signal: new AbortController().signal };
    for (const [platform, target] of [["windows", "deb"], ["linux", "nsis"], ["windows", "msi"]] as const) {
      await expect(pipeline.run({ ...run, source: { repositoryUrl: "https://github.com/example/app.git", commitSha: COMMIT, targets: [target], secretNames: [], platform } })).rejects.toMatchObject({ category: "target.unsupported" });
    }
    await expect(pipeline.run({ ...run, source: { repositoryUrl: "https://github.com/example/app.git", commitSha: COMMIT, targets: ["nsis"], secretNames: [], platform: "windows" } })).rejects.toMatchObject({ category: "configuration.invalid" });
  });
});
