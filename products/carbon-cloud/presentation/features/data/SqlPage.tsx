import { useState } from "react";
import { useServices } from "../../framework/services/context";
import type { ResolvedScope, Scope } from "../../framework/services/contracts";
import type { DataAccess, SavedQuery } from "../../framework/services/data-contracts";
import { CommandForm, choices } from "../identity/Forms";
import { confirmation, DataJobPanel, Download, Inspect, QueryView, useDataParams, useDataQuery } from "./shared";

export function SqlPage({ scope, resolved }: { scope: Scope; resolved: ResolvedScope }) {
  const { data } = useServices(), { params, set, cursor, pager } = useDataParams();
  const [selected, setSelected] = useState<SavedQuery>(), [plan, setPlan] = useState("");
  const tab = params.get("tab") ?? "editor";
  const queries = useDataQuery(scope, ["saved-queries", cursor], (s, c) => s.data.listQueries(c, { cursor, limit: 20 }), tab === "editor");
  const history = useDataQuery(scope, ["sql-history", cursor], (s, c) => s.data.sqlHistory(c, { cursor, limit: 20 }), tab === "history");
  const result = useDataQuery(scope, ["sql-result", params.get("run")], (s, c) => s.data.sqlResult(c, params.get("run")!), !!params.get("run") && resolved.permissions["data.read"].allowed);
  return <><p>Fixture SQL runs only in <strong>{scope.environmentId}</strong>. Query text visibility and execution privileges are separate. History redacts literals; saved/shared text is retained as explicitly entered.</p><nav>{["editor", "history"].map(t => <button key={t} onClick={() => set("tab", t)} aria-pressed={tab === t}>{t}</button>)}</nav><details open><summary>Supported SQL grammar</summary><pre>{`SELECT * FROM notes [LIMIT 100];
INSERT INTO notes DEFAULT VALUES;
UPDATE notes SET title = 'literal without quotes' WHERE id = 'uuid';
DELETE FROM notes WHERE id = 'uuid';
CREATE TABLE tasks (id uuid PRIMARY KEY, title text);`}</pre><p>Single statements only; table names are lowercase identifiers. Brackets above indicate an optional LIMIT clause. INSERT must satisfy required columns and policies. Unknown SQL returns unsupported_operation. This is a bounded fixture parser; no real database execution or cost estimate is claimed.</p></details>
    {tab === "editor" && <><QueryView query={queries}>{queries.data && <><ul>{queries.data.items.map(q => <li key={q.id}><button onClick={() => setSelected(q)}>Open {q.name}</button> · {q.shared ? "project shared" : "personal"} · {q.revision}</li>)}</ul>{!queries.data.items.length && <p>No saved queries. Save your first query below.</p>}{pager(queries.data.nextCursor)}</>}</QueryView><button onClick={() => setSelected(undefined)}>New query</button><CommandForm key={selected?.id ?? "new"} title="Save, explain or execute SQL" revision={selected?.revision} fields={[{ name: "name", label: "Saved query name", value: selected?.name ?? "My query" }, { name: "text", label: "SQL text", type: "textarea", value: selected?.text ?? "SELECT * FROM notes LIMIT 100;" }, { name: "shared", label: "Share query text with project readers", value: String(selected?.shared ?? false), options: choices(["false", "true"]) }, { name: "access", label: "Execution role", value: params.get("access") ?? "administrative", options: choices(["administrative", "policy-preview"]) }, { name: "user", label: "Policy-preview app-user ID (empty = anonymous)", required: false }, { name: "action", label: "Action", value: "save", options: choices(["save", "explain", "execute"]) }, confirmation]} submit={async (v, o) => {
      if (v.action === "save") return data.saveQuery({ scope }, { id: selected?.id, name: v.name, text: v.text, shared: v.shared === "true" }, o);
      if (v.action === "explain") { const result = await data.explainSql({ scope }, v.text); if (!result.ok) return result; setPlan(result.value); return { ok: true, value: { message: "Fixture plan inspected." } }; }
      const access: DataAccess = v.access === "policy-preview" ? { mode: "policy-preview", userId: v.user || undefined } : { mode: "administrative" };
      return data.executeSql({ scope }, v.text, access, v.production, o);
    }} after={r => { if (r.operationId) set("operation", r.operationId); }}><p>Reads require data.read; mutations require data.write; DDL also requires resources.configure. Production mutations require the explicit environment confirmation. Only the owner can edit a saved query; opening a shared query from another author does not transfer ownership.</p></CommandForm>{plan && <p>{plan}</p>}</>}
    {tab === "history" && <QueryView query={history}>{history.data && <><table><thead><tr><th>Query</th><th>Status</th><th>Result</th></tr></thead><tbody>{history.data.items.map(h => <tr key={h.id}><td>{h.summary}<br />{h.createdAt}<br />{h.actorId}</td><td>{h.status}<br />{h.error}</td><td>{h.count ?? "not reported"} rows · {h.durationMs ?? "unknown"} simulated ms · {h.truncated ? "truncated" : "not truncated / pending"}<br /><button onClick={() => set("operation", h.operationId)}>Progress</button><button disabled={h.status !== "succeeded" || !resolved.permissions["data.read"].allowed} onClick={() => set("run", h.id)}>Read results</button></td></tr>)}</tbody></table>{!history.data.items.length && <p>No SQL execution history.</p>}{pager(history.data.nextCursor)}</>}</QueryView>}
    <DataJobPanel scope={scope} id={params.get("operation") ?? undefined} />{params.get("run") && resolved.permissions["data.read"].allowed && <section><h2>Authorized SQL result</h2><QueryView query={result}>{result.data && <><Inspect value={{ columns: result.data.columns, rows: result.data.rows }} /><Download get={async () => { const r = await data.sqlResult({ scope }, params.get("run")!); return r.ok ? { ok: true, value: r.value.download } : r; }} /></>}</QueryView></section>}
  </>;
}
