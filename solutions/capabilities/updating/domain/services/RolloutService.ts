// Staged-rollout gating.
//
// Ported from V1 tools/updater/src/rollout.rs, including its test properties
// (see rollout.test.ts).
//
// The gate has to be a pure function of (installation, version): a machine
// must land in the same bucket every time it checks, or a rollout would
// oscillate and hand out updates it had already excluded. Hashing the version
// in as well means a machine unlucky at 10% for one release is re-shuffled for
// the next, rather than being permanently last in line.

import { createHash } from "node:crypto";

export function inRollout(installationId: string, version: string, rolloutPct: number): boolean {
  if (rolloutPct >= 100) return true;
  if (rolloutPct <= 0) return false;

  const hash = createHash("sha256").update(`${installationId}${version}`).digest();
  const bucket = hash.readUInt32BE(0) % 100;
  return bucket < rolloutPct;
}
