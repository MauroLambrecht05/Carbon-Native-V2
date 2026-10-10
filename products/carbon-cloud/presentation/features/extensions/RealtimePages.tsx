import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { scopePath } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import type { RealtimeMessage, RowEvent } from "../../framework/services/extension-contracts";
import { jsonField, QueryView, Inspect, useDataParams, useDataQuery } from "../data/shared";
import { denied, ExtensionForm, type Props } from "./shared";

export function RealtimePage({ scope, resolved }: Props) {
  const nav = useDataParams(), tableId = nav.params.get("table") ?? "";
  const tables = useDataQuery(scope, ["realtime-tables"], (s, c) => s.data.listTables(c, { limit: 100 }));
  const configs = useDataQuery(scope, ["realtime-configs"], (s, c) => s.extensions.list(c, "realtime", { limit: 100 }));
  const config = configs.data?.items.find(c => c.tableId === tableId), { extensions } = useServices();
  const [connected, setConnected] = useState(false), [cursor, setCursor] = useState<string>(), [message, setMessage] = useState<RealtimeMessage>(), [events, setEvents] = useState<RowEvent[]>([]), [error, setError] = useState<unknown>(), [refetch, setRefetch] = useState(0);
  const app = useDataQuery(scope, ["realtime-app"], (s) => s.appAuth.currentSession(`realm_${scope.environmentId}`));
  const rows = useDataQuery(scope, ["realtime-refetch", tableId, refetch], (s) => s.appAuth.queryRows(`realm_${scope.environmentId}`, tableId, {}), !!tableId && !!app.data);
  useEffect(() => { setEvents([]); setMessage(undefined); setCursor(undefined); setConnected(false); }, [tableId, app.data?.session.id]);
  useEffect(() => {
    if (!connected || !tableId) return; const controller = new AbortController(); let close = () => {}, stopped = false;
    void extensions.subscribe({ scope, signal: controller.signal }, tableId, cursor, next => { if (stopped) return; setMessage(next); setCursor(next.cursor);
      // Rebuild the visible stream on every delivery to avoid retaining rows after policy changes.
      setEvents(next.events.slice(-100));
      if (next.state === "gap") { setEvents([]); setRefetch(n => n + 1); }
      if (next.state === "closed") { setConnected(false); setEvents([]); }
    }).then(result => { if (!result.ok) { if (!stopped) { setError(result.error.message); setConnected(false); } } else if (stopped) result.value(); else close = result.value; });
    return () => { stopped = true; controller.abort(); close(); };
  }, [connected, tableId, app.data?.session.id, extensions, scope.orgId, scope.projectId, scope.environmentId]);
  return <section><p>Inspector uses the active verified app session in this environment. The dashboard permission only permits inspection; row policies still apply. Capture covers accepted mock row mutations, including the bounded SQL fixtures. It is not a WAL feed and does not claim raw backend SQL coverage.</p><QueryView query={tables}><label>Table<select value={tableId} onChange={e => nav.set("table", e.target.value)}><option value="">Choose table</option>{tables.data?.items.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>{tables.data?.nextCursor && <p>Use the table catalog to locate tables beyond the first 100.</p>}</QueryView>{tableId && <QueryView query={configs}><ExtensionForm scope={scope} title="Save realtime capture" revision={config?.revision} disabled={denied(resolved, "resources.configure") ?? denied(resolved, "data.read")} fields={[jsonField("events", "Events JSON (empty disables capture)", config?.events ?? ["insert", "update", "delete"])]} command={v => ({ kind: "realtime.save", tableId, events: JSON.parse(v.events) })} /></QueryView>}<p><Link to={`/app-auth/realm_${encodeURIComponent(scope.environmentId!)}/sign-in`}>Open hosted app sign-in</Link> · <Link to={`${scopePath(scope)}/auth/providers`}>Open authorized realm inbox</Link></p><QueryView query={app}><p>App identity: {app.data?.user.email ?? "Not signed in"}</p></QueryView><button disabled={!tableId || !app.data || !!denied(resolved, "data.read")} onClick={() => { setError(undefined); setConnected(!connected); if (connected) { setMessage({ state: "closed", cursor: cursor ?? "0", events: [], reason: "Simulated disconnect. Reconnect resumes from cursor." }); setEvents([]); } }}>{connected ? "Simulate disconnect" : "Connect / resume inspector"}</button><button onClick={() => { setCursor("0"); setConnected(false); setEvents([]); }}>Set old cursor to exercise resume gap</button>{error !== undefined && <Feedback error={error} />}<Inspect value={message && { ...message, events: undefined }} /><h2>Latest authorized event batch</h2><Inspect value={events} /><p>Event IDs deduplicate delivery. The local replay window keeps 200 committed events. History beyond it reports a gap and refetches authorized rows.</p>{tableId && app.data && <QueryView query={rows}><h2>Current policy-authorized rows</h2><Inspect value={rows.data?.items} /></QueryView>}</section>;
}
