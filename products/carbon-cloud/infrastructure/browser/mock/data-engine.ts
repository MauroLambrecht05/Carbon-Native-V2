import type { Column, Constraint, DataAccess, DataRow, DataTable, ImportInput, ImportPreview, Json, RowCommand, RowQuery, RowValues, Rule, SchemaCommand } from "../../../presentation/framework/services/data-contracts";
import type { CommandOptions, Page, Scope } from "../../../presentation/framework/services/contracts";
import { Refusal } from "./access";
import { allocate, bump } from "./identity-state";
import { now } from "./clock";
import { checkRevision, dataAudit, environmentAccess, jsonObject, production, tableFor, timestamp } from "./data-common";
import { dataState, type DataJob } from "./data-state";
import type { MockState } from "./store";

export const identifier = (value: string) => { if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value) || ["__proto__", "constructor", "prototype"].includes(value)) throw new Refusal("validation", "Identifiers use lowercase letters, digits and underscores, start with a letter/underscore, and contain at most 63 characters."); return value; };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function decimal(value: string) {
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const integer = whole.replace(/^0+(?=\d)/, ""), tail = fraction.replace(/0+$/, "");
  return `${negative && (integer !== "0" || tail) ? "-" : ""}${integer}${tail ? `.${tail}` : ""}`;
}
function compareDecimal(a: string, b: string) {
  if (!/^-?\d+(\.\d+)?$/.test(a) || !/^-?\d+(\.\d+)?$/.test(b)) throw new Refusal("validation", "Decimal comparisons require base-10 strings.");
  const first = decimal(a), second = decimal(b), negative = first.startsWith("-");
  if (negative !== second.startsWith("-")) return negative ? -1 : 1;
  const [ai, af = ""] = first.replace(/^-/, "").split("."), [bi, bf = ""] = second.replace(/^-/, "").split(".");
  const length = Math.max(af.length, bf.length), ap = af.padEnd(length, "0"), bp = bf.padEnd(length, "0");
  const result = ai.length !== bi.length ? Math.sign(ai.length - bi.length) : ai !== bi ? ai < bi ? -1 : 1 : ap === bp ? 0 : ap < bp ? -1 : 1;
  return negative ? -result : result;
}
export function typed(value: Json, column: Column): Json {
  if (value === null) { if (!column.nullable) throw new Refusal("validation", `${column.name} cannot be SQL NULL.`); return null; }
  const bad = () => { throw new Refusal("validation", `${column.name} requires ${column.type}. Decimal values use base-10 strings.`); };
  switch (column.type) {
    case "text": if (typeof value !== "string") bad(); break;
    case "integer": if (typeof value !== "number" || !Number.isSafeInteger(value)) bad(); break;
    case "decimal": if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) bad(); return decimal(value as string);
    case "boolean": if (typeof value !== "boolean") bad(); break;
    case "timestamp": if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) bad(); return new Date(value as string).toISOString();
    case "uuid": if (typeof value !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value)) bad(); break;
    case "json": case "jsonb": if (JSON.stringify(value).length > 100_000) bad(); break;
    case "text[]": if (!Array.isArray(value) || value.some(x => typeof x !== "string")) bad(); break;
    case "integer[]": if (!Array.isArray(value) || value.some(x => typeof x !== "number" || !Number.isSafeInteger(x))) bad(); break;
    default: bad();
  }
  return structuredClone(value);
}
export function validateColumns(columns: Column[], primaryKey?: string) {
  if (!Array.isArray(columns) || !columns.length || columns.length > 50) throw new Refusal("validation", "Use 1–50 columns.");
  const names = new Set<string>();
  for (const c of columns) {
    identifier(c.name); if (names.has(c.name)) throw new Refusal("validation", "Duplicate column name."); names.add(c.name);
    if (typeof c.nullable !== "boolean" || !["text", "integer", "decimal", "boolean", "timestamp", "uuid", "json", "jsonb", "text[]", "integer[]"].includes(c.type)) throw new Refusal("validation", "Unsupported column type or nullability.");
    if (c.default) {
      if (c.default.kind === "literal") typed(c.default.value, c);
      else if (!((c.default.kind === "uuid" && c.type === "uuid") || (c.default.kind === "now" && c.type === "timestamp"))) throw new Refusal("validation", "Only typed literal, UUID and timestamp-now defaults are supported.");
    }
  }
  if (primaryKey && (!names.has(primaryKey) || columns.find(c => c.name === primaryKey)!.nullable || ["json", "jsonb", "text[]", "integer[]"].includes(columns.find(c => c.name === primaryKey)!.type))) throw new Refusal("validation", "Primary key must be a non-null scalar column.");
}
export function validatePolicies(table: DataTable, policies: Rule[]) {
  if (!Array.isArray(policies)) throw new Refusal("validation", "Policies must be an array.");
  const ids = new Set<string>();
  for (const rule of policies) {
    identifier(rule.id); if (ids.has(rule.id) || !rule.name?.trim()) throw new Refusal("validation", "Policies need unique IDs and names."); ids.add(rule.id);
    if (!Array.isArray(rule.operations) || !rule.operations.length || rule.operations.some(x => !["select", "insert", "update", "delete"].includes(x))) throw new Refusal("validation", "Select supported policy operations.");
    if (rule.kind === "public-read") { if (rule.operations.some(x => x !== "select")) throw new Refusal("validation", "Public policy permits reads only."); }
    else if (rule.kind === "owner") { if (!table.columns.some(c => c.name === rule.ownerColumn && ["text", "uuid"].includes(c.type))) throw new Refusal("validation", "Owner policy requires a text/UUID owner field in this realm."); }
    else throw new Refusal("validation", "Unknown policy expression. Supported rules are owner and public-read; unknown expressions fail closed.");
  }
}
export function policy(state: MockState, table: DataTable, userId: string | undefined, operation: Rule["operations"][number], existing: RowValues, proposed?: RowValues) {
  if (userId) { const user = dataState(state).users[userId]; if (!user || user.realmId !== `realm_${table.scope.environmentId}` || user.status !== "active" || !user.verified) return { allowed: false, detail: "Identity is not an active verified user of this environment's realm." }; }
  // RLS off is an explicit grant to verified clients; anonymous access still needs public-read.
  if (!table.rls && userId) return { allowed: true, detail: "RLS is disabled: verified realm clients have table access." };
  const matches = (values: RowValues) => table.policies.filter(rule => rule.operations.includes(operation) && (rule.kind === "public-read" ? operation === "select" : rule.kind === "owner" && !!userId && values[rule.ownerColumn!] === userId));
  const old = matches(existing), next = proposed ? matches(proposed) : old;
  const allowed = old.length > 0 && next.length > 0;
  return { allowed, detail: allowed ? `Matched ${[...new Set([...old, ...next].map(r => r.name))].join(", ")}; existing and proposed values checked.` : "Default deny: no applicable rule for the identity and both row versions." };
}
export function canonical(state: MockState, table: DataTable, input: RowValues, wall: number, original?: RowValues): RowValues {
  jsonObject(input, "Row");
  if (Object.keys(input).some(key => !table.columns.some(c => c.name === key))) throw new Refusal("validation", "Row contains an unknown column.");
  const result: RowValues = {};
  for (const c of table.columns) {
    let value = Object.hasOwn(input, c.name) ? input[c.name] : original?.[c.name];
    if (value === undefined) {
      if (c.default?.kind === "literal") value = c.default.value;
      else if (c.default?.kind === "uuid") value = crypto.randomUUID();
      else if (c.default?.kind === "now") value = timestamp(state, wall);
      else if (c.nullable) value = null;
      else throw new Refusal("validation", `${c.name} is required (missing is distinct from NULL and empty text).`);
    }
    result[c.name] = typed(value, c);
  }
  return result;
}
export const tableRows = (state: MockState, table: DataTable) => Object.values(dataState(state).rows).filter(r => r.tableId === table.id);
export function validateRecords(state: MockState, table: DataTable) {
  const rows = tableRows(state, table);
  const unique = [...table.constraints.filter(c => c.kind === "unique"), ...(table.primaryKey ? [{ name: "primary key", columns: [table.primaryKey] }] : [])];
  for (const c of unique) {
    const seen = new Set<string>();
    for (const row of rows) { const values = c.columns.map(col => row.values[col]); if (values.includes(null)) continue; const key = JSON.stringify(values); if (seen.has(key)) throw new Refusal("conflict", `Duplicate value violates ${c.name}.`); seen.add(key); }
  }
  for (const c of table.constraints) for (const row of rows) {
    if (c.kind === "foreign-key") { const value = row.values[c.columns[0]]; if (value !== null && !tableRows(state, tableFor(state, table.scope, c.targetTableId!)).some(target => equal(target.values[c.targetColumn!], value))) throw new Refusal("conflict", `Foreign key ${c.name} has no matching target. No cascade was applied.`); }
    if (c.kind === "check" && c.check) { const v = row.values[c.check.column], expected = c.check.value; if (v === null) continue; const numeric = table.columns.find(x => x.name === c.check!.column)?.type === "decimal"; const a = numeric ? compareDecimal(String(v), String(expected)) : v; const b = numeric ? 0 : expected; if (!(c.check.operator === "ne" ? !equal(v, expected) : c.check.operator === "gte" ? (a as number) >= (b as number) : (a as number) <= (b as number))) throw new Refusal("validation", `Check ${c.name} failed.`); }
  }
}
export function validateEnvironmentRecords(state: MockState, scope: Scope) { for (const t of Object.values(dataState(state).tables).filter(t => t.scope.environmentId === scope.environmentId)) { for (const constraint of t.constraints) validateConstraint(state, t, constraint); validateRecords(state, t); } }
export function validateConstraint(state: MockState, table: DataTable, c: Constraint) {
  identifier(c.id); identifier(c.name);
  if (!["unique", "foreign-key", "check", "index"].includes(c.kind) || !Array.isArray(c.columns) || !c.columns.length || c.columns.some(name => !table.columns.some(col => col.name === name)) || new Set(c.columns).size !== c.columns.length) throw new Refusal("validation", "Constraint needs valid, distinct columns and a supported kind.");
  if (table.constraints.some(x => x.id !== c.id && x.name === c.name)) throw new Refusal("conflict", "Constraint name already exists.");
  if (c.kind === "foreign-key") { const target = tableFor(state, table.scope, c.targetTableId!); if (c.columns.length !== 1 || !target.columns.some(col => col.name === c.targetColumn && col.type === table.columns.find(x => x.name === c.columns[0])!.type) || !(target.primaryKey === c.targetColumn || target.constraints.some(x => x.kind === "unique" && x.columns.length === 1 && x.columns[0] === c.targetColumn))) throw new Refusal("validation", "Foreign key needs a same-environment, same-type, unique scalar target."); }
  if (c.kind === "check") { if (!c.check || !c.columns.includes(c.check.column) || !["gte", "lte", "ne"].includes(c.check.operator)) throw new Refusal("validation", "Only structured gte/lte/ne checks are supported."); const col = table.columns.find(x => x.name === c.check!.column)!; typed(c.check.value, col); if (c.check.operator !== "ne" && !["integer", "decimal"].includes(col.type)) throw new Refusal("validation", "Range checks require numeric columns."); }
}
export function dependencies(state: MockState, table: DataTable, column?: string) {
  const result: string[] = [];
  if (column && table.primaryKey === column) result.push("primary key");
  for (const c of table.constraints) if (!column || c.columns.includes(column)) result.push(`constraint/index ${c.name}`);
  for (const p of table.policies) if (!column || p.ownerColumn === column) result.push(`policy ${p.name}`);
  for (const other of Object.values(dataState(state).tables)) for (const c of other.constraints) if (c.targetTableId === table.id && (!column || c.targetColumn === column)) result.push(`foreign key ${other.name}.${c.name}`);
  return result;
}
export function applySchema(state: MockState, scope: Scope, command: SchemaCommand, options: CommandOptions, wall: number): string {
  if (!["create", "rename", "drop", "truncate", "column", "constraint", "constraint-delete", "policies", "primary-key"].includes(command.kind)) throw new Refusal("unsupported_operation", "Unknown schema command.");
  if ((command.kind === "create" || command.kind === "policies") && typeof command.rls !== "boolean") throw new Refusal("validation", "RLS must be explicitly enabled or disabled.");
  const data = dataState(state);
  if (command.kind === "create") {
    identifier(command.name); validateColumns(command.columns, command.primaryKey);
    if (Object.values(data.tables).some(t => t.scope.environmentId === scope.environmentId && t.name === command.name)) throw new Refusal("conflict", "Table name is already used in public schema.");
    const id = allocate(state, "table"), table: DataTable = { id, scope, schema: "public", name: command.name, columns: structuredClone(command.columns), primaryKey: command.primaryKey, rls: command.rls, policies: structuredClone(command.policies), constraints: [], revision: "r1", actions: { configure: { allowed: false }, read: { allowed: false }, write: { allowed: false } } };
    validatePolicies(table, table.policies); data.tables[id] = table; return id;
  }
  const table = tableFor(state, scope, command.tableId); checkRevision(table.revision, options);
  if (command.kind === "rename") { identifier(command.name); if (Object.values(data.tables).some(t => t.id !== table.id && t.scope.environmentId === scope.environmentId && t.name === command.name)) throw new Refusal("conflict", "Table name is already used."); table.name = command.name; }
  if (command.kind === "drop" || command.kind === "truncate") {
    if (command.confirmation !== table.name) throw new Refusal("validation", `Type ${table.name} to ${command.kind} exactly ${tableRows(state, table).length} rows. No backup is created by this action.`);
    if (command.kind === "drop" && Object.values(data.tables).some(t => t.constraints.some(c => c.targetTableId === table.id))) throw new Refusal("conflict", "Remove dependent foreign keys first. Cascading deletion is disabled.");
    for (const row of tableRows(state, table)) delete data.rows[row.id];
    if (command.kind === "drop") delete data.tables[table.id];
  }
  if (command.kind === "column") {
    const original = command.original ? table.columns.find(c => c.name === command.original) : undefined;
    if (command.original && !original) throw new Refusal("not_found", "Column not found.");
    if (original && dependencies(state, table, original.name).length) throw new Refusal("conflict", `Resolve dependencies first: ${dependencies(state, table, original.name).join(", ")}. Review migration dependencies before changing this column.`);
    const columns = table.columns.filter(c => c.name !== command.original); if (command.column) columns.push(command.column); validateColumns(columns, table.primaryKey);
    for (const row of tableRows(state, table)) {
      const values = { ...row.values }; const value = original ? values[original.name] : undefined; if (original) delete values[original.name];
      if (command.column && value !== undefined) { let converted = value; if (original?.type !== command.column.type && value !== null) { if (command.column.type === "text" && typeof value !== "object") converted = String(value); else if (command.column.type === "integer" && typeof value === "string" && /^-?\d+$/.test(value)) converted = Number(value); else if (command.column.type === "decimal" && typeof value === "number") converted = String(value); else if (command.column.type !== original?.type) throw new Refusal("unsupported_operation", "This conversion is outside the supported migration fixture grammar; no values changed."); } values[command.column.name] = converted; }
      row.values = canonical(state, { ...table, columns }, values, wall); row.revision = bump(row.revision);
    }
    table.columns = structuredClone(columns);
  }
  if (command.kind === "primary-key") { validateColumns(table.columns, command.column); table.primaryKey = command.column; }
  if (command.kind === "policies") { validatePolicies(table, command.policies); table.rls = command.rls; table.policies = structuredClone(command.policies); }
  if (command.kind === "constraint") { validateConstraint(state, table, command.constraint); table.constraints = [...table.constraints.filter(c => c.id !== command.constraint.id), structuredClone(command.constraint)]; }
  if (command.kind === "constraint-delete") { if (!table.constraints.some(c => c.id === command.constraintId)) throw new Refusal("not_found", "Constraint not found."); const c = table.constraints.find(c => c.id === command.constraintId)!; if (c.kind === "unique" && Object.values(data.tables).some(t => t.constraints.some(f => f.targetTableId === table.id && c.columns.includes(f.targetColumn!)))) throw new Refusal("conflict", "Foreign keys depend on this unique constraint."); table.constraints = table.constraints.filter(c => c.id !== command.constraintId); }
  validateEnvironmentRecords(state, scope); table.revision = bump(table.revision); return table.id;
}
export function applyRows(state: MockState, table: DataTable, command: RowCommand, access: DataAccess, options: CommandOptions, wall: number): string {
  if (state.extensions?.locks[table.scope.environmentId!]) throw new Refusal("conflict", "Environment writes are paused by a restore operation.");
  if (!["insert", "update", "delete"].includes(command.kind)) throw new Refusal("unsupported_operation", "Unknown row command.");
  if (!table.primaryKey) throw new Refusal("unsupported_operation", "This table has no stable primary key. Define one before editing rows.");
  const data = dataState(state);
  if (command.kind === "delete") {
    if (!command.rows.length || new Set(command.rows.map(r => r.id)).size !== command.rows.length || command.confirmation !== String(command.rows.length)) throw new Refusal("validation", "Review selected IDs and type the exact selected count.");
    for (const selected of command.rows) { const row = data.rows[selected.id]; if (!row || row.tableId !== table.id) throw new Refusal("not_found", "Selected row not found."); checkRevision(row.revision, { ...options, expectedRevision: selected.revision }); if (access.mode === "policy-preview" && !policy(state, table, access.userId, "delete", row.values).allowed) throw new Refusal("forbidden", "Policy denies deletion. No rows were deleted."); delete data.rows[row.id]; }
    validateEnvironmentRecords(state, table.scope); table.revision = bump(table.revision); return table.id;
  }
  const row = command.kind === "update" ? data.rows[command.rowId] : undefined;
  if (command.kind === "update") { if (!row || row.tableId !== table.id) throw new Refusal("not_found", "Row not found."); checkRevision(row.revision, options); }
  const values = canonical(state, table, command.values, wall, row?.values);
  if (access.mode === "policy-preview" && !policy(state, table, access.userId, command.kind, row?.values ?? values, values).allowed) throw new Refusal("forbidden", "Policy denies the existing or proposed row. Ownership cannot be reassigned outside your policy.");
  const id = row?.id ?? allocate(state, "row"); data.rows[id] = { id, tableId: table.id, revision: row ? bump(row.revision) : "r1", values };
  validateEnvironmentRecords(state, table.scope); table.revision = bump(table.revision); return id;
}
export function selectRows(state: MockState, table: DataTable, query: RowQuery, access: DataAccess): DataRow[] {
  const columns = new Set(table.columns.map(c => c.name));
  if (query.columns?.some(c => !columns.has(c)) || (query.sort && (!columns.has(query.sort.column) || !["asc", "desc"].includes(query.sort.direction)))) throw new Refusal("validation", "Unknown selected/sort column.");
  for (const f of query.filters ?? []) if (!columns.has(f.column) || !["eq", "ne", "contains", "gt", "lt", "is-null"].includes(f.operator) || (f.path && (!Array.isArray(f.path) || f.path.some(p => typeof p !== "string" || ["__proto__", "prototype", "constructor"].includes(p)) || !["json", "jsonb"].includes(table.columns.find(c => c.name === f.column)!.type)))) throw new Refusal("validation", "Unsupported structured filter or JSON path.");
  let rows = tableRows(state, table).filter(row => access.mode === "administrative" || policy(state, table, access.userId, "select", row.values).allowed);
  if (query.selectedIds) rows = rows.filter(row => query.selectedIds!.includes(row.id));
  rows = rows.filter(row => (query.filters ?? []).every(f => { let value: Json | undefined = row.values[f.column]; for (const path of f.path ?? []) value = value !== null && typeof value === "object" && Object.hasOwn(value, path) ? (value as Record<string, Json>)[path] : undefined; const numeric = !f.path?.length && table.columns.find(c => c.name === f.column)?.type === "decimal"; const a = numeric && value != null && f.operator !== "is-null" ? compareDecimal(String(value), String(f.value)) : value, b = numeric ? 0 : f.value; switch (f.operator) { case "eq": return numeric && value != null ? a === 0 : equal(value, f.value); case "ne": return numeric && value != null ? a !== 0 : !equal(value, f.value); case "contains": return typeof value === "string" && value.includes(String(f.value)); case "gt": return value != null && (a as number) > (b as number); case "lt": return value != null && (a as number) < (b as number); case "is-null": return value === null; } }));
  rows.sort((a, b) => { if (query.sort) { const col = table.columns.find(c => c.name === query.sort!.column)!; let av = a.values[col.name], bv = b.values[col.name]; if (col.type === "decimal" && av !== null && bv !== null) { av = compareDecimal(String(av), String(bv)); bv = 0; } const comparison = equal(av, bv) ? 0 : av === null ? -1 : bv === null ? 1 : av < bv ? -1 : 1; if (comparison) return query.sort.direction === "desc" ? -comparison : comparison; } return a.id.localeCompare(b.id); });
  return rows;
}
export function rowsPage(rows: DataRow[], query: RowQuery, visibility: string): Page<DataRow> {
  const limit = query.limit ?? 20; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Refusal("validation", "Page size is 1–100.");
  const signature = JSON.stringify([visibility, { ...query, cursor: undefined }]); let start = 0;
  if (query.cursor) { try { const cursor = JSON.parse(decodeURIComponent(query.cursor)); if (cursor.signature !== signature) throw Error(); const index = rows.findIndex(r => r.id === cursor.after); if (index < 0) throw Error(); start = index + 1; } catch { throw new Refusal("validation", "Stale query cursor. Return to the first page."); } }
  const items = rows.slice(start, start + limit).map(row => ({ ...row, values: query.columns?.length ? Object.fromEntries(query.columns.map(c => [c, row.values[c]])) : row.values }));
  return { items, total: rows.length, nextCursor: start + limit < rows.length ? encodeURIComponent(JSON.stringify({ signature, after: items.at(-1)!.id })) : null };
}
function csv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else if (!quoted && field) throw new Refusal("validation", "Unexpected CSV quote."); else quoted = !quoted; } else if (!quoted && (c === "," || c === "\n" || c === "\r")) { row.push(field); field = ""; if (c !== ",") { if (c === "\r" && text[i + 1] === "\n") i++; rows.push(row); row = []; } } else field += c; }
  if (quoted) throw new Refusal("validation", "Unclosed CSV quote."); if (field || row.length) { row.push(field); rows.push(row); } return rows;
}
export function importPreview(state: MockState, table: DataTable, input: ImportInput, wall: number): ImportPreview {
  if (input.text.length > 1_000_000 || !["error", "skip", "update"].includes(input.conflict) || typeof input.atomic !== "boolean") throw new Refusal("validation", "Invalid import options or fixture larger than 1 MB.");
  let source: RowValues[];
  if (input.format === "json") { try { source = JSON.parse(input.text); } catch { throw new Refusal("validation", "Invalid JSON import."); } if (!Array.isArray(source)) throw new Refusal("validation", "JSON import must be an array of row objects."); }
  else if (input.format === "csv") { const records = csv(input.text), headers = records.shift() ?? []; if (!headers.length || new Set(headers).size !== headers.length) throw new Refusal("validation", "CSV needs distinct headers."); source = records.map(record => { if (record.length !== headers.length) return { __invalid_csv__: "Column count differs from headers" }; return Object.fromEntries(headers.map((h, i) => [h, record[i]])); }); }
  else throw new Refusal("validation", "Use CSV or JSON.");
  if (source.length > 1000) throw new Refusal("quota_exceeded", "Mock imports support at most 1,000 rows.");
  const rows: RowValues[] = [], errors: { row: number; message: string }[] = [];
  source.forEach((value, index) => { try { jsonObject(value, "Import row"); const mapped: RowValues = {}; for (const [sourceName, v] of Object.entries(value)) { const target = input.mapping[sourceName] ?? sourceName; if (!target) continue; if (Object.hasOwn(mapped, target)) throw new Refusal("validation", "Multiple input fields map to the same column."); const col = table.columns.find(c => c.name === target); let converted = v; if (input.format === "csv" && col && typeof v === "string") { if (v === "\\N") converted = null; else if (!["text", "uuid", "timestamp", "decimal"].includes(col.type)) { try { converted = JSON.parse(v); } catch { throw new Refusal("validation", `${target}: CSV value must be JSON for ${col.type}. Use \\N for SQL NULL.`); } } } mapped[target] = converted; }
    // A disposable draft validates conflicts and dependencies across imported rows.
    rows.push(mapped);
  } catch (e) { rows.push({}); errors.push({ row: index + 1, message: (e as Error).message }); } });
  const draft = structuredClone(state), target = tableFor(draft, table.scope, table.id);
  rows.forEach((values, index) => { if (errors.some(e => e.row === index + 1)) return; const before = structuredClone(draft.data); try { importOne(draft, target.id, values, input.conflict, wall); } catch (e) { draft.data = before; errors.push({ row: index + 1, message: (e as Error).message }); } });
  return { rows, errors, total: source.length, schemaRevision: table.revision };
}
function importOne(state: MockState, tableId: string, values: RowValues, conflict: ImportInput["conflict"], wall: number) {
  const table = dataState(state).tables[tableId]; const existing = table.primaryKey && Object.hasOwn(values, table.primaryKey) ? tableRows(state, table).find(r => equal(r.values[table.primaryKey!], values[table.primaryKey!])) : undefined;
  if (existing && conflict === "skip") return false;
  if (existing && conflict === "error") throw new Refusal("conflict", "Primary key already exists.");
  applyRows(state, table, existing ? { kind: "update", rowId: existing.id, values } : { kind: "insert", values }, { mode: "administrative" }, { idempotencyKey: "import-internal", expectedRevision: existing?.revision }, wall); return true;
}
export type SqlPlan = { kind: "select" | "insert" | "update" | "delete" | "create"; tableName: string; limit?: number; key?: string; title?: string };
export function parseSql(text: string): SqlPlan {
  const sql = text.trim().replace(/;$/, "").trim(); let m: RegExpMatchArray | null;
  if ((m = sql.match(/^select\s+\*\s+from\s+([a-z_][a-z0-9_]*)(?:\s+limit\s+(\d+))?$/i))) return { kind: "select", tableName: m[1].toLowerCase(), limit: Math.min(Number(m[2] ?? 100), 100) };
  if ((m = sql.match(/^insert\s+into\s+([a-z_][a-z0-9_]*)\s+default\s+values$/i))) return { kind: "insert", tableName: m[1].toLowerCase() };
  if ((m = sql.match(/^delete\s+from\s+([a-z_][a-z0-9_]*)\s+where\s+id\s*=\s*'([\da-f-]+)'$/i))) return { kind: "delete", tableName: m[1].toLowerCase(), key: m[2] };
  if ((m = sql.match(/^update\s+([a-z_][a-z0-9_]*)\s+set\s+title\s*=\s*'([^']*)'\s+where\s+id\s*=\s*'([\da-f-]+)'$/i))) return { kind: "update", tableName: m[1].toLowerCase(), title: m[2], key: m[3] };
  if ((m = sql.match(/^create\s+table\s+([a-z_][a-z0-9_]*)\s*\(\s*id\s+uuid\s+primary\s+key\s*,\s*title\s+text\s*\)$/i))) return { kind: "create", tableName: m[1].toLowerCase() };
  throw new Refusal("unsupported_operation", "SQL is outside the documented fixture grammar. No query was executed.");
}
export function startJob(state: MockState, scope: Scope, sessionId: string, job: Omit<DataJob, "scope" | "sessionId" | "deadline">, requestId: string, wall: number) {
  const id = allocate(state, "operation"), createdAt = timestamp(state, wall);
  state.operations[id] = { deadline: Number.MAX_SAFE_INTEGER, failStep: null, record: { id, kind: `data.${job.payload.kind}`, scope, actorId: state.sessions[sessionId].accountId, state: "queued", completedSteps: 0, totalSteps: 2, steps: ["Validate current access and snapshot", "Commit transaction / produce result"], revision: "r1", createdAt, updatedAt: createdAt, requestId, actions: { cancel: { allowed: false, reason: "Use the data operation controls." }, retry: { allowed: false, reason: "Review the data workflow and submit a new operation." } } } };
  dataState(state).jobs[id] = { ...job, scope, sessionId, deadline: now(state.clock, wall) + 1000 }; return id;
}
function executeJob(state: MockState, id: string, wall: number) {
  const data = dataState(state), job = data.jobs[id], payload = job.payload;
  const authorState = { ...state, activeSessionId: job.sessionId };
  environmentAccess(authorState, { scope: job.scope }, job.permission, wall, !job.tableId && payload.kind === "export" ? "auth" : "database");
  if (job.permission !== "data.read") production(authorState, job.scope, job.confirmation ?? "", wall);
  if (payload.kind === "export") { job.result = { message: `${payload.rows.length} snapshot rows exported.`, errors: [], download: { filename: payload.filename, contentType: "application/json", text: JSON.stringify(payload.rows, null, 2) } }; return; }
  if (payload.kind === "sql") {
    const plan = parseSql(payload.text); const run = data.sqlRuns[payload.runId];
    if (plan.kind === "create") { applySchema(state, job.scope, { kind: "create", name: plan.tableName, columns: [{ name: "id", type: "uuid", nullable: false, default: { kind: "uuid" } }, { name: "title", type: "text", nullable: true }], primaryKey: "id", rls: true, policies: [] }, { idempotencyKey: id }, wall); run.count = 0; job.sqlRows = []; }
    else {
      const table = tableFor(state, job.scope, job.tableId!); checkRevision(table.revision, { idempotencyKey: id, expectedRevision: job.expectedRevision }); job.sqlColumns = structuredClone(table.columns);
      if (plan.kind === "select") { const rows = selectRows(state, table, {}, job.access!); run.count = rows.length; run.truncated = rows.length > plan.limit!; job.sqlRows = rows.slice(0, plan.limit).map(r => r.values); }
      else { const row = tableRows(state, table).find(r => r.values.id === plan.key); if (plan.kind === "insert") { const rowId = applyRows(state, table, { kind: "insert", values: {} }, job.access!, { idempotencyKey: id }, wall); job.sqlRows = [dataState(state).rows[rowId].values]; run.count = 1; } else if (row) { applyRows(state, table, plan.kind === "delete" ? { kind: "delete", rows: [{ id: row.id, revision: row.revision }], confirmation: "1" } : { kind: "update", rowId: row.id, values: { title: plan.title! } }, job.access!, { idempotencyKey: id, expectedRevision: row.revision }, wall); run.count = 1; job.sqlRows = []; } else { run.count = 0; job.sqlRows = []; } }
    }
    run.durationMs = 2000; job.result = { message: `${run.count} rows affected/returned; simulated execution timing.`, errors: [] }; return;
  }
  const table = tableFor(state, job.scope, job.tableId!); checkRevision(table.revision, { idempotencyKey: id, expectedRevision: job.expectedRevision });
  if (payload.kind === "index") { applySchema(state, job.scope, { kind: "constraint", tableId: table.id, constraint: payload.constraint }, { idempotencyKey: id, expectedRevision: table.revision }, wall); job.result = { message: "Index is ready.", errors: [] }; return; }
  const preview = importPreview(state, table, payload.input, wall);
  if (payload.input.atomic && preview.errors.length) throw new Refusal("validation", `Atomic import rejected: row ${preview.errors[0].row}: ${preview.errors[0].message}`);
  let saved = 0;
  preview.rows.forEach((values, index) => { if (!preview.errors.some(e => e.row === index + 1) && importOne(state, table.id, values, payload.input.conflict, wall)) saved++; });
  dataState(state).jobs[id].result = { message: `${saved} rows saved; ${preview.errors.length} rejected; ${preview.total - saved - preview.errors.length} skipped. ${payload.input.atomic ? "Atomic" : "Partial"} outcome.`, errors: preview.errors };
}
export function reconcileData(state: MockState, wall: number): boolean {
  const previousCount = state.data?.initialized.length; dataState(state); let changed = previousCount !== state.data!.initialized.length;
  for (const id of Object.keys(state.data!.jobs)) {
    let job = state.data!.jobs[id], record = state.operations[id].record;
    while (job.deadline <= now(state.clock, wall) && ["queued", "running", "cancel_requested"].includes(record.state)) {
      if (record.state === "cancel_requested") Object.assign(record, { state: "cancelled" });
      else if (record.state === "queued") { Object.assign(record, { state: "running", completedSteps: 1 }); }
      else {
        const draft = structuredClone(state);
        try { executeJob(draft, id, wall); state.data = draft.data; state.nextId = draft.nextId; job = state.data!.jobs[id]; Object.assign(record, { state: "succeeded", completedSteps: 2 }); }
        catch (error) { Object.assign(record, { state: "failed", error: { code: error instanceof Refusal ? error.code : "unavailable", message: (error as Error).message, requestId: record.requestId } }); job.result = { message: (error as Error).message, errors: [] }; }
      }
      Object.assign(record, { updatedAt: timestamp(state, wall), revision: bump(record.revision) }); job.deadline += 1000;
      if (job.payload.kind === "sql") { const run = state.data!.sqlRuns[job.payload.runId]; run.status = record.state as typeof run.status; run.revision = bump(run.revision); run.error = record.error?.message; }
      dataAudit(state, job.scope, record.actorId, `data.operation.${record.state}`, id, record.requestId, wall); changed = true;
    }
  }
  for (const session of Object.values(state.data!.sessions)) if (!session.revoked && Date.parse(session.expiresAt) <= now(state.clock, wall)) { session.revoked = true; session.revision = bump(session.revision); changed = true; }
  return changed;
}
