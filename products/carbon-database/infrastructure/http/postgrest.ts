// PostgREST-compliant query parser and handler for Supabase REST API (/rest/v1/:table).
// Translates URL parameters (e.g. ?select=id,name&age=gte.18&order=id.desc) into
// database queries, supporting standard Supabase JS/TS client libraries.

import type { DatabaseEngine } from "../services/DatabaseEngine.ts";
import type { RlsContext } from "../services/RlsPolicyEngine.ts";

export interface PostgrestFilter {
  readonly column: string;
  readonly operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "is" | "in";
  readonly value: any;
}

export function parseFilter(key: string, rawVal: string): PostgrestFilter | null {
  const dotIndex = rawVal.indexOf(".");
  if (dotIndex === -1) {
    return { column: key, operator: "eq", value: rawVal };
  }

  const op = rawVal.slice(0, dotIndex).toLowerCase();
  const val = rawVal.slice(dotIndex + 1);

  switch (op) {
    case "eq":
      return { column: key, operator: "eq", value: parseLiteral(val) };
    case "neq":
      return { column: key, operator: "neq", value: parseLiteral(val) };
    case "gt":
      return { column: key, operator: "gt", value: parseLiteral(val) };
    case "gte":
      return { column: key, operator: "gte", value: parseLiteral(val) };
    case "lt":
      return { column: key, operator: "lt", value: parseLiteral(val) };
    case "lte":
      return { column: key, operator: "lte", value: parseLiteral(val) };
    case "like":
      return { column: key, operator: "like", value: val.replace(/\*/g, "") };
    case "is":
      if (val === "null") return { column: key, operator: "is", value: null };
      if (val === "true") return { column: key, operator: "is", value: true };
      if (val === "false") return { column: key, operator: "is", value: false };
      return { column: key, operator: "is", value: val };
    case "in": {
      const clean = val.replace(/^\(/, "").replace(/\)$/, "");
      const items = clean.split(",").map((s) => parseLiteral(s.trim()));
      return { column: key, operator: "in", value: items };
    }
    default:
      return { column: key, operator: "eq", value: parseLiteral(val) };
  }
}

function parseLiteral(str: string): any {
  if (str === "true") return true;
  if (str === "false") return false;
  if (str === "null") return null;
  if (!isNaN(Number(str)) && str.trim() !== "") return Number(str);
  return str;
}

export async function handlePostgrestRequest(
  req: Request,
  projectId: string,
  tableName: string,
  db: DatabaseEngine,
  rlsContext?: RlsContext,
): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  const table = await db.getTable(projectId, tableName);
  if (!table) {
    return Response.json({ error: `relation "public.${tableName}" does not exist` }, { status: 404 });
  }

  const filters: PostgrestFilter[] = [];
  let selectColumns: string[] | null = null;
  let orderColumn: string | undefined;
  let orderDirection: "asc" | "desc" = "asc";
  let limit = 100;
  let offset = 0;

  for (const [key, value] of url.searchParams.entries()) {
    if (key === "select") {
      selectColumns = value.split(",").map((c) => c.trim());
      continue;
    }
    if (key === "order") {
      const parts = value.split(".");
      orderColumn = parts[0];
      orderDirection = parts[1] === "desc" ? "desc" : "asc";
      continue;
    }
    if (key === "limit") {
      limit = Number(value);
      continue;
    }
    if (key === "offset") {
      offset = Number(value);
      continue;
    }

    const parsed = parseFilter(key, value);
    if (parsed) filters.push(parsed);
  }

  if (method === "GET") {
    // Only "eq" filters push down to SQL today (DatabaseEngine.queryRows'
    // own filter option is equality-only) — every other PostgREST operator
    // (gt/gte/lt/lte/like/is/in) is applied client-side below, same as the
    // in-memory version always did. A real cost at scale (fetches every
    // eq-matching row before non-eq filters trim it down), not attempted
    // as pushdown here — a materially larger query-builder than this pass
    // needs.
    const eqFilter: Record<string, unknown> = {};
    const remaining: PostgrestFilter[] = [];
    for (const f of filters) {
      if (f.operator === "eq") eqFilter[f.column] = f.value;
      else remaining.push(f);
    }

    const rawResult = await db.queryRows(projectId, tableName, { filter: eqFilter, limit: Number.MAX_SAFE_INTEGER }, rlsContext);
    let rows = rawResult.rows;

    for (const f of remaining) {
      rows = rows.filter((r) => {
        const val = r[f.column];
        switch (f.operator) {
          case "neq":
            return val != f.value;
          case "gt":
            return (val as any) > f.value;
          case "gte":
            return (val as any) >= f.value;
          case "lt":
            return (val as any) < f.value;
          case "lte":
            return (val as any) <= f.value;
          case "like":
            return String(val).toLowerCase().includes(String(f.value).toLowerCase());
          case "is":
            return val === f.value;
          case "in":
            return Array.isArray(f.value) && f.value.includes(val);
          default:
            return true;
        }
      });
    }

    if (orderColumn) {
      const col = orderColumn;
      const dir = orderDirection === "desc" ? -1 : 1;
      rows.sort((a, b) => {
        if (a[col] === b[col]) return 0;
        return (a[col] as any) > (b[col] as any) ? dir : -dir;
      });
    }

    const total = rows.length;
    const paginated = rows.slice(offset, offset + limit);

    const projected = selectColumns
      ? paginated.map((r) => {
          const item: Record<string, unknown> = {};
          for (const c of selectColumns!) item[c] = r[c] ?? null;
          return item;
        })
      : paginated;

    const endRange = Math.min(offset + paginated.length, total);
    const contentRange = `${offset}-${Math.max(0, endRange - 1)}/${total}`;

    return Response.json(projected, {
      status: 200,
      headers: { "Content-Range": contentRange, "Content-Type": "application/json" },
    });
  }

  if (method === "POST") {
    const body = await req.json();
    const rowsToInsert = Array.isArray(body) ? body : [body];
    const insertedRows: Record<string, unknown>[] = [];
    for (const item of rowsToInsert) {
      insertedRows.push(await db.insertRow(projectId, tableName, item, rlsContext));
    }
    return Response.json(Array.isArray(body) ? insertedRows : insertedRows[0], {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (method === "PATCH") {
    const updates = (await req.json()) as Record<string, unknown>;
    const simpleFilter: Record<string, unknown> = {};
    for (const f of filters) if (f.operator === "eq") simpleFilter[f.column] = f.value;
    const count = await db.updateRows(projectId, tableName, simpleFilter, updates, rlsContext);
    return Response.json({ updated: count }, { status: 200 });
  }

  if (method === "DELETE") {
    const simpleFilter: Record<string, unknown> = {};
    for (const f of filters) if (f.operator === "eq") simpleFilter[f.column] = f.value;
    const count = await db.deleteRows(projectId, tableName, simpleFilter, rlsContext);
    return Response.json({ deleted: count }, { status: 200 });
  }

  return Response.json({ error: `Method ${method} not allowed on /rest/v1/${tableName}` }, { status: 405 });
}
