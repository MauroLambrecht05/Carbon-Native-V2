import type { EnvironmentScope } from '@carbon/contracts/platform';

/** Runs within the owning service transaction, using only trusted canonical identifiers. */
export interface NativeEnvironmentDriver {
  initialize(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string): Promise<void>;
  setState(tx: Bun.TransactionSQL, scope: EnvironmentScope, remoteId: string, state: 'active' | 'paused'): Promise<void>;
}
