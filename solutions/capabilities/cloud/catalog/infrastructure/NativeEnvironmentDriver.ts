import type { EnvironmentScope } from '@carbon/contracts/platform';

/** Runs within the owning service transaction, using only trusted canonical identifiers. */
export interface NativeEnvironmentDriver {
  initialize(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string): Promise<void>;
  setState(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string, state: 'active' | 'paused'): Promise<void>;
  /**
   * Removes everything this service holds for the environment, inside the caller's transaction. Returns how much
   * of each kind was removed, and the keys of any bytes kept outside the database, which the caller removes after
   * the transaction commits.
   */
  destroy(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string): Promise<EnvironmentDestruction>;
}

export interface EnvironmentDestruction {
  readonly removed: Readonly<Record<string, number>>;
  readonly objects: readonly string[];
}
