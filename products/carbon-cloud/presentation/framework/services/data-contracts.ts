import type { Action, CommandOptions, Page, PageRequest, RequestContext, Result, Scope } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RowValues = Record<string, Json>;
export type ColumnType = "text" | "integer" | "decimal" | "boolean" | "timestamp" | "uuid" | "json" | "jsonb" | "text[]" | "integer[]";
export type Column = { name: string; type: ColumnType; nullable: boolean; default?: { kind: "literal"; value: Json } | { kind: "uuid" | "now" } };
export type Rule = { id: string; name: string; kind: "owner" | "public-read"; operations: ("select" | "insert" | "update" | "delete")[]; ownerColumn?: string };
export type Constraint = { id: string; name: string; kind: "unique" | "foreign-key" | "check" | "index"; columns: string[]; targetTableId?: string; targetColumn?: string; check?: { column: string; operator: "gte" | "lte" | "ne"; value: Json } };
export type DataTable = { id: string; scope: Scope; name: string; schema: "public"; revision: string; columns: Column[]; primaryKey?: string; rls: boolean; policies: Rule[]; constraints: Constraint[]; actions: { configure: Action; read: Action; write: Action } };
export type DataRow = { id: string; tableId: string; revision: string; values: RowValues };
export type DataAccess = { mode: "administrative" } | { mode: "policy-preview"; userId?: string };
export type RowFilter = { column: string; path?: string[]; operator: "eq" | "ne" | "contains" | "gt" | "lt" | "is-null"; value?: Json };
export type RowQuery = { cursor?: string; limit?: number; filters?: RowFilter[]; sort?: { column: string; direction: "asc" | "desc" }; columns?: string[]; selectedIds?: string[] };
export type SchemaCommand =
  | { kind: "create"; name: string; columns: Column[]; primaryKey?: string; rls: boolean; policies: Rule[] }
  | { kind: "rename"; tableId: string; name: string }
  | { kind: "drop" | "truncate"; tableId: string; confirmation: string }
  | { kind: "column"; tableId: string; original?: string; column?: Column }
  | { kind: "constraint"; tableId: string; constraint: Constraint }
  | { kind: "constraint-delete"; tableId: string; constraintId: string }
  | { kind: "policies"; tableId: string; rls: boolean; policies: Rule[] }
  | { kind: "primary-key"; tableId: string; column: string };
export type RowCommand = { kind: "insert"; values: RowValues } | { kind: "update"; rowId: string; values: RowValues } | { kind: "delete"; rows: { id: string; revision: string }[]; confirmation: string };
export type Impact = { resource: string; dependencies: string[]; rowCount?: number; detail: string; revision: string };
export type ImportInput = { format: "json" | "csv"; text: string; mapping: Record<string, string>; conflict: "error" | "skip" | "update"; atomic: boolean };
export type ImportPreview = { rows: RowValues[]; errors: { row: number; message: string }[]; total: number; schemaRevision: string };
export type LocalDownload = { filename: string; contentType: string; text: string };
export type SavedQuery = { id: string; scope: Scope; name: string; text: string; ownerId: string; shared: boolean; revision: string };
export type SqlRun = { id: string; scope: Scope; actorId: string; operationId: string; summary: string; status: "queued" | "running" | "cancel_requested" | "succeeded" | "failed" | "cancelled"; createdAt: string; revision: string; count?: number; durationMs?: number; truncated?: boolean; error?: string };
export interface DataService {
  listTables(context: RequestContext, page?: PageRequest): Promise<Result<Page<DataTable>>>;
  getTable(context: RequestContext, id: string): Promise<Result<DataTable>>;
  previewSchema(context: RequestContext, command: SchemaCommand): Promise<Result<Impact>>;
  schemaCommand(context: RequestContext, command: SchemaCommand, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  queryRows(context: RequestContext, tableId: string, query: RowQuery, access: DataAccess): Promise<Result<Page<DataRow>>>;
  rowCommand(context: RequestContext, tableId: string, command: RowCommand, access: DataAccess, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  previewPolicy(context: RequestContext, tableId: string, userId: string | undefined, operation: Rule["operations"][number], existing: RowValues, proposed?: RowValues): Promise<Result<{ allowed: boolean; detail: string; revision: string }>>;
  previewImport(context: RequestContext, tableId: string, input: ImportInput): Promise<Result<ImportPreview>>;
  importRows(context: RequestContext, tableId: string, input: ImportInput, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  exportRows(context: RequestContext, tableId: string, query: RowQuery, access: DataAccess, options: CommandOptions): Promise<Result<CommandReceipt>>;
  getJobResult(context: RequestContext, operationId: string): Promise<Result<{ message: string; errors: { row: number; message: string }[]; download?: LocalDownload }>>;
  cancelJob(context: RequestContext, operationId: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  generatedTypes(context: RequestContext, tableId: string): Promise<Result<LocalDownload>>;
  listQueries(context: RequestContext, page?: PageRequest): Promise<Result<Page<SavedQuery>>>;
  saveQuery(context: RequestContext, input: { id?: string; name: string; text: string; shared: boolean }, options: CommandOptions): Promise<Result<CommandReceipt>>;
  executeSql(context: RequestContext, text: string, access: DataAccess, confirmation: string, options: CommandOptions): Promise<Result<CommandReceipt>>;
  explainSql(context: RequestContext, text: string): Promise<Result<string>>;
  sqlHistory(context: RequestContext, page?: PageRequest): Promise<Result<Page<SqlRun>>>;
  sqlResult(context: RequestContext, id: string): Promise<Result<{ columns: Column[]; rows: RowValues[]; download: LocalDownload }>>;
}
