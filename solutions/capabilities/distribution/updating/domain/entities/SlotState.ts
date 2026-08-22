// The A/B slot state machine.
//
// The invariant it exists to hold: an update that bricks the app must be
// recoverable without the app running. `in_progress_count` is bumped before a
// launch and cleared on first frame, so a slot that never reaches first frame
// leaves evidence behind that the next launch can act on.
//
// This entity does not know where it is stored. Persistence is
// SlotStateRepository, implemented by
// infrastructure/filesystem/FileSlotStateRepository.ts. That separation is
// what lets the whole crash-loop behaviour be exercised in memory.

export interface SlotStateData {
  active_slot: string;
  previous_slot: string | null;
  in_progress_count: number;
  last_successful_version: string | null;
  installation_id: string;
}

export class SlotState implements SlotStateData {
  active_slot: string;
  previous_slot: string | null;
  in_progress_count: number;
  last_successful_version: string | null;
  installation_id: string;

  constructor(data: SlotStateData) {
    this.active_slot = data.active_slot;
    this.previous_slot = data.previous_slot;
    this.in_progress_count = data.in_progress_count;
    this.last_successful_version = data.last_successful_version;
    this.installation_id = data.installation_id;
  }

  /**
   * First-run state. The installation id is supplied by the caller rather than
   * generated here, so the entity stays free of crypto and deterministic under
   * test.
   */
  static initial(installationId: string, version = "1.0.0"): SlotState {
    return new SlotState({
      active_slot: version,
      previous_slot: null,
      in_progress_count: 0,
      last_successful_version: version,
      installation_id: installationId,
    });
  }

  /** A launch has begun but not yet succeeded. */
  markLaunchStarted(): void {
    this.in_progress_count += 1;
  }

  /** The app reached first frame — the active slot is good. */
  markFirstFrame(): void {
    this.last_successful_version = this.active_slot;
    this.in_progress_count = 0;
  }

  /** Promotes `version` to active, remembering what it replaced. */
  promote(version: string): void {
    this.previous_slot = this.active_slot;
    this.active_slot = version;
    this.in_progress_count = 0;
  }

  /** Swaps active and previous. No-op when there is nothing to go back to. */
  rollback(): void {
    if (this.previous_slot === null) return;
    const prev = this.previous_slot;
    this.previous_slot = this.active_slot;
    this.active_slot = prev;
    this.in_progress_count = 0;
  }

  needsRollback(crashThreshold: number): boolean {
    return this.in_progress_count >= crashThreshold;
  }

  toData(): SlotStateData {
    return {
      active_slot: this.active_slot,
      previous_slot: this.previous_slot,
      in_progress_count: this.in_progress_count,
      last_successful_version: this.last_successful_version,
      installation_id: this.installation_id,
    };
  }
}
