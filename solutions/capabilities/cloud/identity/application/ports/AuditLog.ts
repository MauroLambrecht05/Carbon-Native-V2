import type { AuditEntry, Scope } from '@carbon/contracts/platform';
import type { OrganizationActor } from './OrganizationRepository.ts';

/** A position in the log: the writing transaction, then the row. See Cloud migration 0023 for why both are needed. */
export interface AuditPosition { readonly transaction: string; readonly sequence: string }
/** Entries with the position of each, in the order returned. */
export interface AuditSlice { readonly entries: readonly AuditEntry[]; readonly positions: readonly AuditPosition[] }
export interface AuditLog {
  /** Newest first, for browsing. */
  browse(actor: OrganizationActor, scope: Scope, limit: number, before?: AuditPosition): Promise<AuditSlice>;
  /** Oldest first after a position, for following the log. */
  follow(actor: OrganizationActor, scope: Scope, limit: number, after: AuditPosition): Promise<AuditSlice>;
  /** The position a new follower starts from: everything already visible is behind it. */
  head(actor: OrganizationActor, scope: Scope): Promise<AuditPosition>;
}
/** Organization state changes made by Cloud itself. */
export interface OrganizationLifecycleStore {
  suspend(orgId: string, reasonCode: string, requestId: string): Promise<void>;
  reinstate(orgId: string, requestId: string): Promise<void>;
  finalizeDeletions(requestId: string, limit: number): Promise<readonly string[]>;
}
