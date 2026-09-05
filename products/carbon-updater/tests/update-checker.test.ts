import { describe, expect, test } from "bun:test";
import { UpdateChecker } from "../infrastructure/services/UpdateChecker.ts";
import { SignatureVerifier } from "../infrastructure/services/SignatureVerifier.ts";

describe("UpdateChecker", () => {
  const checker = UpdateChecker.getInstance();
  const verifier = SignatureVerifier.getInstance();

  test("semver comparisons correctly identify newer and older versions", () => {
    expect(checker.isVersionNewer("2.0.0", "1.0.0")).toBe(true);
    expect(checker.isVersionNewer("1.1.0", "1.0.0")).toBe(true);
    expect(checker.isVersionNewer("1.0.1", "1.0.0")).toBe(true);
    expect(checker.isVersionNewer("1.0.0", "1.0.0")).toBe(false);
    expect(checker.isVersionNewer("0.9.0", "1.0.0")).toBe(false);
  });

  test("deterministic rollout bucketing assigns same bucket to same installationId", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const bucket1 = checker.computeRolloutBucket(id);
    const bucket2 = checker.computeRolloutBucket(id);
    expect(bucket1).toBe(bucket2);
    expect(bucket1).toBeGreaterThanOrEqual(0);
    expect(bucket1).toBeLessThan(100);
  });

  test("flags stop-list yanked version immediately", async () => {
    const res = await checker.checkUpdate({
      currentVersion: "1.5.2",
      targetPlatform: "windows-x86_64",
      installationId: "inst-1",
      manifestUrl: "https://releases.example.com/manifest.json",
      trustedPublicKey: "dummy",
      mockStopList: ["1.5.2"],
    });

    expect(res.isYanked).toBe(true);
    expect(res.reason).toContain("yanked");
  });

  test("verifies manifest signature and detects valid update", async () => {
    const { publicKeyPem, signData } = verifier.createTestKeyPair();

    const manifestObj = {
      version: "2.0.0",
      pub_date: "2026-09-04T00:00:00Z",
      channel: "stable",
      rollout: 100, // 100% rollout
      notes: "Feature release",
      platforms: {
        "windows-x86_64": {
          url: "https://releases.example.com/app-2.0.0.exe",
          sha256: "abc123sha",
        },
      },
    };

    const manifestJson = JSON.stringify(manifestObj);
    const signature = signData(manifestJson);

    const res = await checker.checkUpdate({
      currentVersion: "1.0.0",
      targetPlatform: "windows-x86_64",
      installationId: "inst-test",
      manifestUrl: "https://example.com/manifest.json",
      trustedPublicKey: publicKeyPem,
      mockManifestJson: manifestJson,
      mockManifestSig: signature,
    });

    expect(res.updateAvailable).toBe(true);
    expect(res.newVersion).toBe("2.0.0");
    expect(res.downloadUrl).toBe("https://releases.example.com/app-2.0.0.exe");
  });
});
