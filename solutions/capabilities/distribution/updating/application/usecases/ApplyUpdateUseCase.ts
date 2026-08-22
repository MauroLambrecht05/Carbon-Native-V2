// Promoting a staged version into a slot and pointing the app at it.
//
// Ported from V1 tools/updater/src/apply.rs.
//
// The order here is what makes a half-applied update survivable: the directory
// is moved into place first, and only then is state rewritten to name it. A
// crash between the two leaves an unreferenced slot on disk (harmless) rather
// than a state file pointing at a slot that does not exist (fatal).
//
// Persistence goes through SlotStateRepository. SlotState itself is a pure
// entity that does not know where it is stored, so this use case is what joins
// "decide" to "write it down".

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SlotStateRepository } from "../../domain/repositories/SlotStateRepository.ts";
import { FileSlotStateRepository } from "../../infrastructure/FileSlotStateRepository.ts";

export function promoteStaging(stagingDir: string, slotsDir: string, version: string): void {
  const stagedVersion = join(stagingDir, version);
  const targetSlot = join(slotsDir, version);

  if (!existsSync(stagedVersion)) {
    throw new Error(`Staged version ${version} does not exist`);
  }

  mkdirSync(slotsDir, { recursive: true });

  if (existsSync(targetSlot)) {
    rmSync(targetSlot, { recursive: true, force: true });
  }

  renameSync(stagedVersion, targetSlot);
}

export function applyUpdate(
  installDir: string,
  stagingDir: string,
  version: string,
  _platform?: string,
  repository: SlotStateRepository = new FileSlotStateRepository(),
): void {
  const slotsDir = join(installDir, "slots");
  promoteStaging(stagingDir, slotsDir, version);

  const state = repository.load(installDir);
  state.promote(version);
  repository.save(installDir, state);
}
