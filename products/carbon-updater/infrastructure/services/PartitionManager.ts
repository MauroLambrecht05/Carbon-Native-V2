// Partition Manager: A/B slot partition swap and 3-strike crash rollback state machine.
// Persists state in current.toml.

export interface PartitionState {
  active_slot: string;
  previous_slot: string;
  in_progress_count: number;
  installation_id: string;
}

export class PartitionManager {
  private state: PartitionState;

  constructor(initialState?: Partial<PartitionState>) {
    this.state = {
      active_slot: initialState?.active_slot || "1.0.0",
      previous_slot: initialState?.previous_slot || "1.0.0",
      in_progress_count: initialState?.in_progress_count ?? 0,
      installation_id: initialState?.installation_id || "inst_default_001",
    };
  }

  getState(): Readonly<PartitionState> {
    return { ...this.state };
  }

  /**
   * Called on each app launch before the UI event loop starts.
   * If the app crashed 3 consecutive times during launch, automatically
   * rolls back to the previous known good slot!
   */
  reportAppLaunch(): { rollbackTriggered: boolean; activeVersion: string; reason?: string } {
    if (this.state.in_progress_count >= 3 && this.state.previous_slot !== this.state.active_slot) {
      const crashedVersion = this.state.active_slot;
      const safeVersion = this.state.previous_slot;

      // Swap slots back to safe version
      this.state.active_slot = safeVersion;
      this.state.previous_slot = crashedVersion;
      this.state.in_progress_count = 0;

      return {
        rollbackTriggered: true,
        activeVersion: safeVersion,
        reason: `Repeated crash limit (3 strikes) reached on version ${crashedVersion}. Automatically rolled back to ${safeVersion}.`,
      };
    }

    // Increment in-progress launch counter
    this.state.in_progress_count++;
    return {
      rollbackTriggered: false,
      activeVersion: this.state.active_slot,
    };
  }

  /**
   * Called once the app has successfully rendered and is healthy.
   * Clears the crash counter.
   */
  reportAppSuccess(): void {
    this.state.in_progress_count = 0;
  }

  /**
   * Promotes a newly staged update to the active slot.
   */
  promoteSlot(newVersion: string): void {
    this.state.previous_slot = this.state.active_slot;
    this.state.active_slot = newVersion;
    this.state.in_progress_count = 0;
  }

  /**
   * Manually forces a rollback to the previous slot.
   */
  forceRollback(): { activeVersion: string } {
    const temp = this.state.active_slot;
    this.state.active_slot = this.state.previous_slot;
    this.state.previous_slot = temp;
    this.state.in_progress_count = 0;
    return { activeVersion: this.state.active_slot };
  }

  parseToml(content: string): PartitionState {
    const active = content.match(/active_slot\s*=\s*"([^"]+)"/)?.[1] || "1.0.0";
    const previous = content.match(/previous_slot\s*=\s*"([^"]+)"/)?.[1] || "1.0.0";
    const count = Number(content.match(/in_progress_count\s*=\s*(\d+)/)?.[1] || 0);
    const instId = content.match(/installation_id\s*=\s*"([^"]+)"/)?.[1] || "inst_0";

    return {
      active_slot: active,
      previous_slot: previous,
      in_progress_count: count,
      installation_id: instId,
    };
  }

  renderToml(): string {
    return `# Carbon Native A/B Partition State
active_slot = "${this.state.active_slot}"
previous_slot = "${this.state.previous_slot}"
in_progress_count = ${this.state.in_progress_count}
installation_id = "${this.state.installation_id}"
`;
  }
}
