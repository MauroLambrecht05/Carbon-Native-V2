// The publish/rollback/yank pipeline, end to end, against a real keypair and
// a fake-but-behaviorally-real S3 client — real crypto, real merge logic,
// only the network boundary is substituted.
//
// This is the test that would have caught `carbon publish app` never
// uploading anything: it asserts a manifest was actually written where an
// updater would fetch it, that the bytes it verifies against are exactly the
// bytes that got signed, and that a second platform's publish adds to the
// first's rather than replacing it.
//
// ON THE TIMEOUTS: see signing.integration.test.ts — one key generation
// costs a real Argon2id derivation (~2-4s). One key, shared, for every test.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, verifyManifest } from "@carbon/signing";
import {
  PublishReleaseUseCase,
  RollbackReleaseUseCase,
  YankReleaseUseCase,
  type S3Config,
} from "../index.ts";

const KDF = 60_000;
const PASSWORD = "correct horse battery staple";

/** In-memory stand-in for Bun.S3Client, covering exactly the calls
 *  S3ArtifactStore.ts makes: write/file(.exists/.text)/list/delete. */
class FakeS3Client {
  constructor(_opts: unknown) {}

  async write(key: string, value: unknown): Promise<void> {
    if (typeof value === "string") {
      store.set(key, value);
    } else if (value && typeof (value as { text?: unknown }).text === "function") {
      store.set(key, await (value as { text(): Promise<string> }).text());
    } else {
      store.set(key, String(value));
    }
  }

  file(key: string) {
    return {
      exists: async () => store.has(key),
      text: async () => {
        const v = store.get(key);
        if (v === undefined) throw new Error(`FakeS3Client: no such key ${key}`);
        return v;
      },
    };
  }

  async list({ prefix }: { prefix: string }): Promise<{ contents: Array<{ key: string }> }> {
    return { contents: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
  }

  async delete(key: string): Promise<void> {
    store.delete(key);
  }
}

let store: Map<string, string>;
let dir: string;
let keyFile: string;
let pubkeyPath: string;
let pubkeyB64: string;
let s3: S3Config;
let realS3Client: unknown;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "carbon-publish-test-"));
  const key = generate("test-release-key", PASSWORD, dir);
  keyFile = key.seckeyPath;
  pubkeyPath = key.pubkeyPath;
  pubkeyB64 = key.verifyingKey.toBase64();

  realS3Client = (Bun as unknown as { S3Client: unknown }).S3Client;
  (Bun as unknown as { S3Client: unknown }).S3Client = FakeS3Client;

  s3 = {
    type: "s3",
    bucket: "test-bucket",
    prefix: "",
    region: "us-east-1",
    // FakeS3Client ignores these — they exist only to satisfy S3ArtifactStore's
    // client() guard, which refuses to construct without credentials present
    // somewhere (env or config) even though the fake never checks them.
    accessKeyId: "fake",
    secretAccessKey: "fake",
  };
}, KDF);

afterAll(() => {
  (Bun as unknown as { S3Client: unknown }).S3Client = realS3Client;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  store = new Map();
});

function artifact(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("publishing an artifact", () => {
  test("uploads the artifact, signs it, and the manifest verifies against what was published", async () => {
    const artifactPath = artifact("app-1.0.0-win.exe", "pretend installer bytes");
    const expectedSha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");

    const result = await new PublishReleaseUseCase(s3).execute({
      version: "1.0.0",
      channel: "stable",
      rollout: 100,
      platform: "x86_64-pc-windows-msvc",
      artifactPath,
      keyFile,
      password: PASSWORD,
      pubkey: pubkeyB64,
    });

    expect(result.sha256).toBe(expectedSha256);
    expect(result.manifest.platforms["x86_64-pc-windows-msvc"].sha256).toBe(expectedSha256);

    // The artifact itself actually landed where its own URL says it did.
    expect(store.has("releases/1.0.0/app-1.0.0-win.exe")).toBe(true);
    expect(store.get("releases/1.0.0/app-1.0.0-win.exe")).toBe("pretend installer bytes");

    // Both the channel pointer and the per-version snapshot were written.
    expect(store.has("stable/manifest.json")).toBe(true);
    expect(store.has("releases/1.0.0/manifest.json")).toBe(true);
    expect(store.get("stable/manifest.json")).toBe(store.get("releases/1.0.0/manifest.json"));
  }, KDF);

  test("verifyManifest actually accepts the published bytes with the real verifying key", async () => {
    const { readPublicKey } = await import("@carbon/signing");
    const verifyingKey = readPublicKey(pubkeyPath);

    const artifactPath = artifact("app-1.0.1-win.exe", "installer v2");
    await new PublishReleaseUseCase(s3).execute({
      version: "1.0.1",
      channel: "stable",
      rollout: 100,
      platform: "x86_64-pc-windows-msvc",
      artifactPath,
      keyFile,
      password: PASSWORD,
      pubkey: pubkeyB64,
    });

    const fetchedJson = store.get("stable/manifest.json")!;
    const fetchedSig = store.get("stable/manifest.sig")!;
    const manifest = verifyManifest(fetchedJson, fetchedSig, verifyingKey);
    expect(manifest.version).toBe("1.0.1");
  }, KDF);

  test("a second platform's publish adds to the channel instead of replacing it", async () => {
    const winPath = artifact("app-2.0.0-win.exe", "windows bytes");
    const macPath = artifact("app-2.0.0-mac.dmg", "mac bytes");

    await new PublishReleaseUseCase(s3).execute({
      version: "2.0.0", channel: "stable", rollout: 100,
      platform: "x86_64-pc-windows-msvc", artifactPath: winPath,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });
    const second = await new PublishReleaseUseCase(s3).execute({
      version: "2.0.0", channel: "stable", rollout: 100,
      platform: "aarch64-apple-darwin", artifactPath: macPath,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });

    expect(Object.keys(second.manifest.platforms).sort()).toEqual([
      "aarch64-apple-darwin",
      "x86_64-pc-windows-msvc",
    ]);
  }, KDF);

  test("rollout is clamped the same way BuildUpdateManifestUseCase always has", async () => {
    const path = artifact("app-3.0.0.exe", "x");
    const result = await new PublishReleaseUseCase(s3).execute({
      version: "3.0.0", channel: "stable", rollout: 500,
      platform: "x86_64-pc-windows-msvc", artifactPath: path,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });
    expect(result.manifest.rollout).toBe(100);
  }, KDF);
});

describe("rolling back", () => {
  test("restores an exact prior manifest without touching the signing key", async () => {
    const v1 = artifact("app-1.0.0-rb.exe", "v1 bytes");
    const v2 = artifact("app-1.1.0-rb.exe", "v2 bytes");

    await new PublishReleaseUseCase(s3).execute({
      version: "1.0.0", channel: "stable", rollout: 100,
      platform: "x86_64-pc-windows-msvc", artifactPath: v1,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });
    await new PublishReleaseUseCase(s3).execute({
      version: "1.1.0", channel: "stable", rollout: 100,
      platform: "x86_64-pc-windows-msvc", artifactPath: v2,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });
    expect(store.get("stable/manifest.json")).toContain('"version":"1.1.0"');

    const result = await new RollbackReleaseUseCase(s3).execute({ channel: "stable", toVersion: "1.0.0" });

    expect(result.manifest.version).toBe("1.0.0");
    expect(store.get("stable/manifest.json")).toBe(store.get("releases/1.0.0/manifest.json"));
  }, KDF * 2);

  test("refuses to roll back to a version that was never published through this pipeline", async () => {
    await expect(
      new RollbackReleaseUseCase(s3).execute({ channel: "stable", toVersion: "9.9.9" }),
    ).rejects.toThrow(/no published manifest snapshot/);
  });
});

describe("yanking", () => {
  test("adds the version to the channel's yanked list", async () => {
    const path = artifact("app-0.5.0.exe", "x");
    await new PublishReleaseUseCase(s3).execute({
      version: "0.5.0", channel: "beta", rollout: 100,
      platform: "x86_64-pc-windows-msvc", artifactPath: path,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });

    const result = await new YankReleaseUseCase(s3).execute({
      channel: "beta", version: "0.5.0", autoRollback: false,
    });

    expect(result.yankedVersions).toContain("0.5.0");
    const stopList = JSON.parse(store.get("beta/yanked.json")!);
    expect(stopList.yanked.map((e: { version: string }) => e.version)).toContain("0.5.0");
  }, KDF);

  test("auto-rollback without --to refuses rather than guessing", async () => {
    const path = artifact("app-0.6.0.exe", "x");
    await new PublishReleaseUseCase(s3).execute({
      version: "0.6.0", channel: "beta2", rollout: 100,
      platform: "x86_64-pc-windows-msvc", artifactPath: path,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });

    await expect(
      new YankReleaseUseCase(s3).execute({ channel: "beta2", version: "0.6.0", autoRollback: true }),
    ).rejects.toThrow(/no --to/);
  }, KDF);

  test("auto-rollback with --to rolls the channel back when the yanked version is live", async () => {
    const good = artifact("app-0.7.0.exe", "good");
    const bad = artifact("app-0.8.0.exe", "bad");

    await new PublishReleaseUseCase(s3).execute({
      version: "0.7.0", channel: "beta3", rollout: 100,
      platform: "x86_64-pc-windows-msvc", artifactPath: good,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });
    await new PublishReleaseUseCase(s3).execute({
      version: "0.8.0", channel: "beta3", rollout: 100,
      platform: "x86_64-pc-windows-msvc", artifactPath: bad,
      keyFile, password: PASSWORD, pubkey: pubkeyB64,
    });

    const result = await new YankReleaseUseCase(s3).execute({
      channel: "beta3", version: "0.8.0", autoRollback: true, rollbackTo: "0.7.0",
    });

    expect(result.rolledBackTo).toBe("0.7.0");
    expect(store.get("beta3/manifest.json")).toContain('"version":"0.7.0"');
  }, KDF * 2);
});
