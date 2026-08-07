// Where A/B slot state is persisted between launches.
//
// The state machine itself is an entity with no idea where it is stored; that
// separation is what lets "three failed launches trigger a rollback" be tested
// without a temp directory.

import type { SlotState } from "../entities/SlotState.ts";

export interface SlotStateRepository {
  /** Reads persisted state, or mints a fresh installation on first run. */
  load(installDir: string): SlotState;
  save(installDir: string, state: SlotState): void;
}
