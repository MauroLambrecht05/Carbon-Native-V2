// What an installed app does with a verified manifest and stop list.
//
// One function, so every consumer decides the same way. The order of the
// checks is part of the contract and is what the shared conformance fixture
// (solutions/contracts/update/fixtures/conformance.json) pins down; the Rust
// half is rust/application/decide.rs.
//
// The manifest passed in must already have had its signature verified against
// the key the app pins. Nothing here trusts a key the manifest names.

import { createPublicKey, verify } from "node:crypto";
import type { PlatformEntry, UpdaterManifest } from "@carbon/contracts/update";
import type { StopListData } from "../value-objects/StopList.ts";
import { inRollout } from "./RolloutService.ts";
import { compareVersions } from "./VersionOrder.ts";

export type UpdateDecision =
  | { readonly action: "none"; readonly reason: "channel_mismatch" | "invalid_version" | "current" | "older" | "withdrawn" | "incompatible" | "no_platform" | "not_in_rollout" }
  /** The running version was withdrawn: go back to the previous slot. */
  | { readonly action: "rollback"; readonly reason: "current_withdrawn" }
  | { readonly action: "update"; readonly version: string; readonly artifact: PlatformEntry };

export interface UpdateDecisionInput {
  readonly manifest: UpdaterManifest;
  readonly stopList: StopListData;
  readonly currentVersion: string;
  readonly installationId: string;
  /** The key this install looks itself up by in `manifest.platforms`. */
  readonly platform: string;
  /** The channel this install follows. When given, a manifest for another channel is ignored. */
  readonly channel?: string;
}

export function decideUpdate(input: UpdateDecisionInput): UpdateDecision {
  const { manifest, stopList, currentVersion } = input;
  // 1. A manifest signed for another channel must not be accepted on this one.
  if (input.channel !== undefined && manifest.channel !== input.channel) return { action: "none", reason: "channel_mismatch" };
  // 2. A withdrawn running version rolls back whether or not anything newer is offered.
  if (stopList.yanked.some((entry) => entry.version === currentVersion)) return { action: "rollback", reason: "current_withdrawn" };
  // 3. Only a strictly newer version is an update. An older one is never installed.
  const order = compareVersions(manifest.version, currentVersion);
  if (order === null) return { action: "none", reason: "invalid_version" };
  if (order === 0) return { action: "none", reason: "current" };
  if (order < 0) return { action: "none", reason: "older" };
  // 4. A withdrawn version is not installed even if a stale manifest still offers it.
  if (stopList.yanked.some((entry) => entry.version === manifest.version)) return { action: "none", reason: "withdrawn" };
  // 5. Compatibility: installs older than min_version cannot jump straight to this release.
  if (manifest.min_version !== null && manifest.min_version !== undefined) {
    const floor = compareVersions(currentVersion, manifest.min_version);
    if (floor === null) return { action: "none", reason: "invalid_version" };
    if (floor < 0) return { action: "none", reason: "incompatible" };
  }
  // 6. There must be an artifact for this platform.
  const artifact = manifest.platforms[input.platform];
  if (!artifact) return { action: "none", reason: "no_platform" };
  // 7. Staged rollout.
  if (!inRollout(input.installationId, manifest.version, manifest.rollout)) return { action: "none", reason: "not_in_rollout" };
  return { action: "update", version: manifest.version, artifact };
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function strictBase64(value: string, length: number): Buffer | null {
  const bytes = Buffer.from(value, "base64");
  return bytes.length === length && bytes.toString("base64") === value ? bytes : null;
}

/**
 * Verifies an Ed25519 signature over exactly these bytes. The signature and the 32-byte public key are standard
 * base64. Pass the fetched manifest text itself, never a re-serialization of the parsed manifest.
 */
export function verifyUpdateSignature(bytes: string | Uint8Array, signature: string, publicKey: string): boolean {
  const key = strictBase64(publicKey, 32);
  const sig = strictBase64(signature, 64);
  if (!key || !sig) return false;
  try {
    return verify(null, typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes, createPublicKey({ key: Buffer.concat([SPKI_PREFIX, key]), format: "der", type: "spki" }), sig);
  } catch {
    return false;
  }
}
