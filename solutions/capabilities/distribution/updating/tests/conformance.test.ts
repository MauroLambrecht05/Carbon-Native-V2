// The TypeScript updater against the shared conformance fixture. The Rust
// updater (rust/tests/conformance.rs) and the standalone updater
// (products/carbon-updater/tests) run the same file.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { UpdaterManifest } from "@carbon/contracts/update";
import { compareVersions, decideUpdate, inRollout, parseVersion, verifyUpdateSignature, type StopListData } from "../index.ts";

interface Fixture {
  publicKey: string;
  signatures: { name: string; manifest: string; signature: string; publicKey: string; valid: boolean }[];
  versions: { a: string; b: string; expected: number }[];
  invalidVersions: string[];
  rollout: { installationId: string; version: string; percent: number; bucket: number; offered: boolean }[];
  decisions: { name: string; manifest: UpdaterManifest; stopList: StopListData; currentVersion: string; installationId: string; platform: string; channel: string | null;
    expected: { action: string; reason?: string; version?: string } }[];
}
const fixture = JSON.parse(readFileSync(new URL("../../../../contracts/update/fixtures/conformance.json", import.meta.url), "utf8")) as Fixture;

describe("update conformance: TypeScript updater", () => {
  test("the fixture is not empty", () => {
    expect(fixture.signatures.length).toBeGreaterThanOrEqual(8); expect(fixture.versions.length).toBeGreaterThanOrEqual(20);
    expect(fixture.rollout.length).toBeGreaterThanOrEqual(72); expect(fixture.decisions.length).toBeGreaterThanOrEqual(22);
  });

  test("signature bytes", () => {
    for (const item of fixture.signatures) expect([item.name, verifyUpdateSignature(item.manifest, item.signature, item.publicKey)]).toEqual([item.name, item.valid]);
  });

  test("version ordering", () => {
    for (const item of fixture.versions) {
      expect([item.a, item.b, Math.sign(compareVersions(item.a, item.b)!)]).toEqual([item.a, item.b, item.expected]);
      // Ordering is antisymmetric.
      expect([item.b, item.a, Math.sign(compareVersions(item.b, item.a)!)]).toEqual([item.b, item.a, item.expected === 0 ? 0 : -item.expected]);
    }
    for (const version of fixture.invalidVersions) { expect([version, parseVersion(version)]).toEqual([version, null]); expect(compareVersions(version, "1.0.0")).toBeNull(); expect(compareVersions("1.0.0", version)).toBeNull(); }
  });

  test("rollout bucket", () => {
    for (const item of fixture.rollout) expect([item.installationId, item.version, item.percent, inRollout(item.installationId, item.version, item.percent)]).toEqual([item.installationId, item.version, item.percent, item.offered]);
  });

  test("decisions: stop list, compatibility, channel movement, platform and rollout", () => {
    for (const item of fixture.decisions) {
      const decision = decideUpdate({ manifest: item.manifest, stopList: item.stopList, currentVersion: item.currentVersion, installationId: item.installationId, platform: item.platform, ...(item.channel === null ? {} : { channel: item.channel }) });
      const actual: { action: string; reason?: string; version?: string } = decision.action === "update" ? { action: "update", version: decision.version } : { action: decision.action, reason: decision.reason };
      expect([item.name, actual]).toEqual([item.name, item.expected]);
      if (decision.action === "update") expect(decision.artifact).toEqual(item.manifest.platforms[item.platform]!);
    }
  });
});
