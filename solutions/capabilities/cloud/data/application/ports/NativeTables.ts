import type { EnvironmentScope, Permission, Principal, DataMutation, DataCommandReceipt, DataTable, DataTablesQuery, DataTablesResult, DataRowSelection } from '@carbon/contracts/platform';
import type { NativeDefinition, NativePolicySet } from '../../domain/NativeTable.ts';
import type { DataChangesQuery, DataChangesResult, DataQuery, DataQueryResult } from '@carbon/contracts/platform';
import type { DataSchemaChange, DataSchemaPreview } from '@carbon/contracts/platform';
import type { DataImportExecution, DataImportExecutionResult } from '@carbon/contracts/platform';

/** Trusted composition port; callers must verify a signed principal and exact request/scope.
 * This callback must recheck live authority, not trust caller-supplied permission claims. */
export interface NativeDataAuthority {
  readonly scope: EnvironmentScope;
  readonly bindingId: string;
  readonly principal: Principal;
  readonly requestId: string;
  permit(permission: Permission): Promise<boolean>;
}
export type NativeTableRecord = DataTable;
export interface NativeRow { readonly id: string; readonly revision: string; readonly values: Record<string, unknown> }
/** Preview identity is allowed only for account callers with data access, and is audited. */
export type NativeRowAccess = { readonly mode: 'application' } | { readonly mode: 'policy-preview'; readonly userId?: string };

export interface NativeTablesRepository {
  applyImport(authority: NativeDataAuthority, input: DataImportExecution): Promise<DataImportExecutionResult>;
  importStatus(authority: NativeDataAuthority, input: DataImportExecution): Promise<DataImportExecutionResult | null>;
  preview(authority: NativeDataAuthority, id: string, change: DataSchemaChange): Promise<DataSchemaPreview>;
  queryPage(authority: NativeDataAuthority, input: DataQuery): Promise<DataQueryResult>;
  /** The table's change feed after a cursor, in commit order, filtered to what this reader could see. */
  changes(authority: NativeDataAuthority, input: DataChangesQuery): Promise<DataChangesResult>;
  list(authority: NativeDataAuthority, input: DataTablesQuery): Promise<DataTablesResult>;
  get(authority: NativeDataAuthority, id: string): Promise<NativeTableRecord>;
  command(authority: NativeDataAuthority, input: DataMutation): Promise<DataCommandReceipt>;
  create(authority: NativeDataAuthority, id: string, input: NativeDefinition): Promise<NativeTableRecord>;
  replacePolicies(authority: NativeDataAuthority, id: string, revision: string, input: NativePolicySet): Promise<NativeTableRecord>;
  query(authority: NativeDataAuthority, id: string, access: NativeRowAccess, limit?: number, afterId?: string, selection?: DataRowSelection): Promise<readonly NativeRow[]>;
  insert(authority: NativeDataAuthority, id: string, access: NativeRowAccess, input: Record<string, unknown>): Promise<NativeRow>;
  update(authority: NativeDataAuthority, id: string, access: NativeRowAccess, rowId: string, revision: string, input: Record<string, unknown>): Promise<NativeRow>;
  delete(authority: NativeDataAuthority, id: string, access: NativeRowAccess, rowId: string, revision: string): Promise<void>;
}
