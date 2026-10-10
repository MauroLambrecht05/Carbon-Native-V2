import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { UpdaterManifest } from "@carbon/contracts/update";
import { UpdateChecker } from "../infrastructure/services/UpdateChecker.ts";
import { SignatureVerifier } from "../infrastructure/services/SignatureVerifier.ts";

// The shared conformance fixture: the same cases the TypeScript and Rust updaters run.
interface Fixture {
  publicKey: string;
  signatures: { name: string; manifest: string; signature: string; publicKey: string; valid: boolean }[];
  versions: { a: string; b: string; expected: number }[];
  invalidVersions: string[];
  decisions: { name: string; manifest: UpdaterManifest; stopList: { yanked: { version: string }[] }; currentVersion: string; installationId: string; platform: string; channel: string | null;
    expected: { action: string; reason?: string; version?: string } }[];
}
const fixture = JSON.parse(readFileSync(new URL("../../../solutions/contracts/update/fixtures/conformance.json", import.meta.url), "utf8")) as Fixture;

describe("UpdateChecker", () => {
  const checker = UpdateChecker.getInstance();
  const verifier = SignatureVerifier.getInstance();
  const options = { currentVersion: "1.5.0", targetPlatform: "x86_64-pc-windows-msvc", installationId: "inst-1", manifestUrl: "https://releases.example.com/stable/manifest.json" };

  test("conformance: signature bytes", async () => {
    for (const item of fixture.signatures) {
      const outcome = await checker.checkUpdate({ ...options, trustedPublicKey: item.publicKey, mockManifestJson: item.manifest, mockManifestSig: item.signature }).then(() => true, () => false);
      expect([item.name, outcome]).toEqual([item.name, item.valid]);
    }
  });

  test("conformance: version ordering", () => {
    for (const item of fixture.versions) {
      expect([item.a, item.b, checker.isVersionNewer(item.a, item.b)]).toEqual([item.a, item.b, item.expected > 0]);
      expect([item.b, item.a, checker.isVersionNewer(item.b, item.a)]).toEqual([item.b, item.a, item.expected < 0]);
    }
    for (const version of fixture.invalidVersions) { expect(checker.isVersionNewer(version, "1.0.0")).toBe(false); expect(checker.isVersionNewer("9.0.0", version)).toBe(false); }
  });

  test("conformance: rollout, stop list, compatibility, platform and channel decisions", async () => {
    const { publicKeyRawBase64, signData } = verifier.createTestKeyPair();
    expect(fixture.decisions.length).toBeGreaterThanOrEqual(22);
    for (const item of fixture.decisions) {
      const manifestJson = JSON.stringify(item.manifest);
      const result = await checker.checkUpdate({ currentVersion: item.currentVersion, targetPlatform: item.platform, installationId: item.installationId, manifestUrl: options.manifestUrl,
        trustedPublicKey: publicKeyRawBase64, mockManifestJson: manifestJson, mockManifestSig: signData(manifestJson), mockStopList: item.stopList.yanked.map((entry) => entry.version),
        ...(item.channel === null ? {} : { channel: item.channel }) });
      const actual = result.updateAvailable ? { action: "update", version: result.newVersion } : result.isYanked ? { action: "rollback" } : { action: "none" };
      expect([item.name, actual]).toEqual([item.name, item.expected.action === "update" ? { action: "update", version: item.expected.version } : { action: item.expected.action }]);
      if (result.updateAvailable) { expect(result.downloadUrl).toBe(item.manifest.platforms[item.platform]!.url); expect(result.sha256).toBe(item.manifest.platforms[item.platform]!.sha256); }
      // Only the rollout gate reports the version it is holding back.
      if (item.expected.reason === "not_in_rollout") expect(result.newVersion).toBe(item.manifest.version); else if (!result.updateAvailable) expect(result.newVersion).toBeUndefined();
    }
  });

  test("an unsigned manifest is refused", async () => {
    const manifestJson = fixture.signatures[0]!.manifest;
    await expect(checker.checkUpdate({ ...options, trustedPublicKey: fixture.publicKey, mockManifestJson: manifestJson })).rejects.toThrow("no signature");
    await expect(checker.checkUpdate({ ...options, trustedPublicKey: fixture.publicKey, mockManifestJson: manifestJson, mockManifestSig: " " })).rejects.toThrow();
  });

  test("a PEM key verifies the same signature as its raw form", async () => {
    const { publicKeyPem, publicKeyRawBase64, signData } = verifier.createTestKeyPair();
    const manifestJson = fixture.signatures[0]!.manifest; const signature = signData(manifestJson);
    for (const trustedPublicKey of [publicKeyPem, publicKeyRawBase64]) {
      const result = await checker.checkUpdate({ ...options, installationId: fixture.decisions[0]!.installationId, trustedPublicKey, mockManifestJson: manifestJson, mockManifestSig: signature });
      expect(result).toMatchObject({ updateAvailable: true, newVersion: "2.0.0" });
    }
  });
});
