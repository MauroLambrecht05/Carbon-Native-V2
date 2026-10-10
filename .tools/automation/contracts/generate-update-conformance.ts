// Generates solutions/contracts/update/fixtures/conformance.json: the cases
// every consumer of an update manifest must agree on. Manifests are built and
// serialized by the publisher's own code (BuildUpdateManifestUseCase and
// canonicalizeManifest) and signed with a fixed test key, so the bytes are the
// ones a real release announces.
//
// Expected results are written out here by hand, or derived from the bucket
// formula directly — never from the functions under test.
//
//   bun .tools/automation/contracts/generate-update-conformance.ts          writes the fixture
//   bun .tools/automation/contracts/generate-update-conformance.ts --check  fails if it is stale
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { PlatformEntry, UpdaterManifest } from "@carbon/contracts/update";
import { BuildUpdateManifestUseCase } from "../../../solutions/capabilities/distribution/publishing/application/usecases/BuildUpdateManifestUseCase.ts";
import { canonicalizeManifest } from "../../../solutions/capabilities/distribution/signing/application/usecases/SignManifestUseCase.ts";

const target = new URL("../../../solutions/contracts/update/fixtures/conformance.json", import.meta.url);
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
// Test keys only. They sign nothing but this fixture.
function keypair(seedByte: number) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, seedByte)]), format: "der", type: "pkcs8" });
  const publicKey = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");
  return { publicKey, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64") };
}
const app = keypair(7);
const attacker = keypair(9);

const WINDOWS = "x86_64-pc-windows-msvc";
const artifact: PlatformEntry = { signature: app.sign("installer bytes"), url: "https://downloads.example.test/artifacts/app/2.0.0/setup.exe", sha256: createHash("sha256").update("installer bytes").digest("hex") };
function manifest(overrides: Partial<{ version: string; channel: string; rollout: number; minVersion: string | null; pubkey: string }> = {}): UpdaterManifest {
  return new BuildUpdateManifestUseCase().execute({ version: overrides.version ?? "2.0.0", channel: overrides.channel ?? "stable", rollout: overrides.rollout ?? 50, pubkey: overrides.pubkey ?? app.publicKey,
    notes: "Conformance release", minVersion: overrides.minVersion === undefined ? "1.5.0" : overrides.minVersion, platforms: { [WINDOWS]: artifact }, now: new Date("2026-10-10T00:00:00Z") });
}

// ── Signature bytes ──────────────────────────────────────────────────────────
const signedText = canonicalizeManifest(manifest());
const signature = app.sign(signedText);
const forgedText = canonicalizeManifest(manifest({ version: "9.9.9", pubkey: attacker.publicKey }));
const signatures = [
  { name: "the publisher's bytes and signature", manifest: signedText, signature, publicKey: app.publicKey, valid: true },
  { name: "one changed character", manifest: signedText.replace('"rollout":50', '"rollout":51'), signature, publicKey: app.publicKey, valid: false },
  { name: "the same manifest re-serialized with whitespace", manifest: JSON.stringify(JSON.parse(signedText), null, 2), signature, publicKey: app.publicKey, valid: false },
  { name: "a signature by another key", manifest: signedText, signature: attacker.sign(signedText), publicKey: app.publicKey, valid: false },
  { name: "a manifest that names and is signed by an attacker's key, checked against the pinned key", manifest: forgedText, signature: attacker.sign(forgedText), publicKey: app.publicKey, valid: false },
  { name: "a truncated signature", manifest: signedText, signature: signature.slice(0, 40), publicKey: app.publicKey, valid: false },
  { name: "a signature that is not base64", manifest: signedText, signature: "not a signature!", publicKey: app.publicKey, valid: false },
  { name: "a public key of the wrong length", manifest: signedText, signature, publicKey: app.publicKey.slice(0, 20), valid: false },
];

// ── Version ordering ─────────────────────────────────────────────────────────
// Sign of compare(a, b): -1 when a is older, 0 when equal precedence, 1 when newer.
const versions: [string, string, -1 | 0 | 1][] = [
  ["1.0.0", "1.0.0", 0], ["1.0.1", "1.0.0", 1], ["0.9.0", "1.0.0", -1], ["1.10.0", "1.9.0", 1], ["2.0.0", "1.99.99", 1], ["1.0.10", "1.0.9", 1],
  ["1.0.0-rc.1", "1.0.0", -1], ["1.0.0", "1.0.0-rc.1", 1], ["1.0.0-alpha", "1.0.0-alpha.1", -1], ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], ["1.0.0-alpha.beta", "1.0.0-beta", -1],
  ["1.0.0-beta", "1.0.0-beta.2", -1], ["1.0.0-beta.2", "1.0.0-beta.11", -1], ["1.0.0-beta.11", "1.0.0-rc.1", -1], ["1.0.0-10", "1.0.0-9", 1], ["1.0.0-a10", "1.0.0-a9", -1],
  ["1.0.0-rc.1", "1.0.0-rc.1", 0], ["1.0.0+build.1", "1.0.0+build.2", 0], ["1.0.0-rc.1+sha.abc", "1.0.0-rc.1", 0], ["1.0.0-RC", "1.0.0-rc", -1],
];
const invalidVersions = ["", "1", "1.0", "1.0.0.0", "v1.0.0", "01.0.0", "1.00.0", "1.0.x", "1.0.0-", "1.0.0-01", "1.0.0-rc..1", "1.0.0 ", " 1.0.0", "1.0.0+", "1.0.0-rc_1", "1234567890123456.0.0", "banana"];

// ── Rollout bucket ───────────────────────────────────────────────────────────
// bucket = (first four bytes of SHA-256(installationId + version), big-endian) mod 100; offered when bucket < percent.
const bucket = (installationId: string, version: string) => createHash("sha256").update(`${installationId}${version}`).digest().readUInt32BE(0) % 100;
const rollout = ["install-0", "install-1", "install-2", "550e8400-e29b-41d4-a716-446655440000", "installation with spaces", "ünïcödé-install"].flatMap((installationId) =>
  ["1.0.0", "2.0.0"].flatMap((version) => [0, 1, 10, 50, 99, 100].map((percent) => {
    const value = bucket(installationId, version);
    return { installationId, version, percent, bucket: value, offered: percent >= 100 ? true : percent <= 0 ? false : value < percent };
  })));

// ── Decisions ────────────────────────────────────────────────────────────────
const find = (version: string, admitted: boolean) => { for (let index = 0; ; index++) if ((bucket(`install-${index}`, version) < 50) === admitted) return `install-${index}`; };
const inside = find("2.0.0", true);
const outside = find("2.0.0", false);
const none = { yanked: [], generated_at: "2026-10-10T00:00:00.000Z" };
const withdrawn = (version: string) => ({ yanked: [{ version, reason: "Crash on launch", yanked_at: "2026-10-10T00:00:00.000Z" }], generated_at: "2026-10-10T00:00:00.000Z" });
const base = { manifest: manifest(), stopList: none, currentVersion: "1.5.0", installationId: inside, platform: WINDOWS, channel: "stable" as string | null };
const update = { action: "update", version: "2.0.0" };
const decisions = [
  { name: "a newer version, in the rollout, compatible, for this platform", ...base, expected: update },
  { name: "outside the rollout", ...base, installationId: outside, expected: { action: "none", reason: "not_in_rollout" } },
  { name: "a full rollout admits an install the staged one excluded", ...base, manifest: manifest({ rollout: 100 }), installationId: outside, expected: update },
  { name: "a paused rollout admits nobody", ...base, manifest: manifest({ rollout: 0 }), expected: { action: "none", reason: "not_in_rollout" } },
  { name: "already on the offered version", ...base, currentVersion: "2.0.0", expected: { action: "none", reason: "current" } },
  { name: "the same version with different build metadata is not an update", ...base, currentVersion: "2.0.0+local", expected: { action: "none", reason: "current" } },
  { name: "a channel moved back to an older release never downgrades an install", ...base, currentVersion: "2.1.0", expected: { action: "none", reason: "older" } },
  { name: "a release candidate updates to its release", ...base, currentVersion: "2.0.0-rc.1", expected: update },
  { name: "a release does not update to its own release candidate", ...base, manifest: manifest({ version: "2.0.0-rc.1" }), currentVersion: "2.0.0", installationId: "install-0", expected: { action: "none", reason: "older" } },
  { name: "an install older than min_version is refused", ...base, currentVersion: "1.4.9", expected: { action: "none", reason: "incompatible" } },
  { name: "an install exactly at min_version is accepted", ...base, currentVersion: "1.5.0", expected: update },
  { name: "no min_version means any older install may update", ...base, manifest: manifest({ rollout: 100, minVersion: null }), currentVersion: "0.1.0", expected: update },
  { name: "no artifact for this platform", ...base, platform: "aarch64-apple-darwin", expected: { action: "none", reason: "no_platform" } },
  { name: "a manifest for another channel", ...base, channel: "beta", expected: { action: "none", reason: "channel_mismatch" } },
  { name: "a consumer that follows no named channel accepts the manifest it was given", ...base, manifest: manifest({ channel: "beta" }), channel: null, expected: update },
  { name: "the running version was withdrawn", ...base, stopList: withdrawn("1.5.0"), expected: { action: "rollback", reason: "current_withdrawn" } },
  { name: "the running version was withdrawn and nothing newer is offered", ...base, currentVersion: "2.0.0", stopList: withdrawn("2.0.0"), expected: { action: "rollback", reason: "current_withdrawn" } },
  { name: "a withdrawn running version rolls back even outside the rollout", ...base, installationId: outside, stopList: withdrawn("1.5.0"), expected: { action: "rollback", reason: "current_withdrawn" } },
  { name: "a stale manifest still offers a withdrawn version", ...base, stopList: withdrawn("2.0.0"), expected: { action: "none", reason: "withdrawn" } },
  { name: "a withdrawal of some other version changes nothing", ...base, stopList: withdrawn("1.9.0"), expected: update },
  { name: "the running version is not a version", ...base, currentVersion: "banana", expected: { action: "none", reason: "invalid_version" } },
  { name: "the offered version is not a version", ...base, manifest: { ...manifest(), version: "latest" }, expected: { action: "none", reason: "invalid_version" } },
];

const text = `${JSON.stringify({
  description: "Generated by .tools/automation/contracts/generate-update-conformance.ts. Do not edit by hand.",
  publicKey: app.publicKey, signatures, versions: versions.map(([a, b, expected]) => ({ a, b, expected })), invalidVersions, rollout, decisions,
}, null, 2)}\n`;
if (process.argv.includes("--check")) {
  let current = ""; try { current = readFileSync(target, "utf8").replace(/\r\n/g, "\n"); } catch { /* missing is stale */ }
  if (current !== text) { console.error("solutions/contracts/update/fixtures/conformance.json is stale; run generate-update-conformance.ts"); process.exit(1); }
} else writeFileSync(target, text);
