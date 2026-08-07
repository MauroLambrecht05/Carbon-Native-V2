// Crash-loop detection.
//
// Ported from V1 tools/updater/src/rollback.rs.
//
// The decision is the entity's (`needsRollback`, `rollback`); persisting the
// result is the repository's. This use case joins the two, which is why the
// write happens here rather than inside the entity.

import type { SlotState } from "../../domain/entities/SlotState.ts";
import type { SlotStateRepository } from "../../domain/repositories/SlotStateRepository.ts";
import { FileSlotStateRepository } from "../../infrastructure/FileSlotStateRepository.ts";

/**
 * Rolls back if the active slot has failed to reach first frame too often.
 * Returns whether a rollback was performed.
 */
export function handleCrashDetection(
  state: SlotState,
  crashThreshold: number,
  installDir: string,
  repository: SlotStateRepository = new FileSlotStateRepository(),
): boolean {
  if (!state.needsRollback(crashThreshold)) return false;

  state.rollback();
  repository.save(installDir, state);
  return true;
}
