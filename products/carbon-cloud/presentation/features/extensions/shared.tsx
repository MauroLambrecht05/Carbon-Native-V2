import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useServices } from "../../framework/services/context";
import type { ResolvedScope, Scope } from "../../framework/services/contracts";
import type { ExtensionCommand } from "../../framework/services/extension-contracts";
import { CommandForm, type Field } from "../identity/Forms";
import { confirmation, Inspect, QueryView, useDataQuery } from "../data/shared";
import { scopePath } from "../../framework/routing/routes";

export type Props = { scope: Scope; resolved: ResolvedScope };
export const booleanField = (name: string, label: string, value = false): Field => ({ name, label, value: String(value), options: [{ value: "false", label: "No" }, { value: "true", label: "Yes" }] });
export function ExtensionForm({ scope, title, fields = [], revision, command, disabled, after, children }: { scope: Scope; title: string; fields?: Field[]; revision?: string; command: (values: Record<string, string>) => ExtensionCommand; disabled?: string; after?: (id?: string) => void; children?: ReactNode }) {
  const { extensions } = useServices();
  return <CommandForm title={title} fields={[...fields, confirmation]} revision={revision} disabled={disabled} submit={(v, o) => extensions.command({ scope }, command(v), v.production, o)} after={r => after?.(r.operationId ?? r.resourceId)}>{children}</CommandForm>;
}
export const denied = (resolved: ResolvedScope, permission: "data.read" | "data.write" | "resources.configure") => resolved.permissions[permission].allowed ? undefined : resolved.permissions[permission].reason ?? `${permission} permission required.`;
export function ExtensionJobs({ scope, selected }: { scope: Scope; selected?: string }) {
  const list = useDataQuery(scope, ["extension-jobs"], (s, c) => s.operations.list(c, { limit: 100 }));
  const [chosen, setChosen] = useState<string>();
  const id = chosen ?? selected;
  const operations = list.data?.items.filter(o => o.kind === "data.extension") ?? [];
  const query = useDataQuery(scope, ["extension-job", id], (s, c) => s.operations.get(c, id!), !!id);
  const result = useDataQuery(scope, ["extension-result", id, query.data?.revision], (s, c) => s.extensions.jobResult(c, id!), !!id && ["succeeded", "failed", "cancelled"].includes(query.data?.state ?? ""));
  const { extensions } = useServices();
  return <section><h2>Data extension operations</h2><QueryView query={list}><label>Inspect operation<select value={chosen ?? ""} onChange={e => setChosen(e.target.value)}><option value="">Choose operation</option>{operations.map(o => <option key={o.id} value={o.id}>{o.id} · {o.state}</option>)}</select></label>{!operations.length && <p>No extension operations yet.</p>}</QueryView>{selected && <p>Latest operation: {selected}</p>}{id && <QueryView query={query}>{query.data && <><p>{id} · {query.data.state}</p><progress value={query.data.completedSteps} max={query.data.totalSteps} /><p>{query.data.error?.message}</p>{["queued", "running"].includes(query.data.state) && <CommandForm title={`Cancel ${id}`} revision={query.data.revision} submit={(_, o) => extensions.cancel({ scope }, id, o)} />}{["succeeded", "failed", "cancelled"].includes(query.data.state) && <QueryView query={result}><Inspect value={result.data} />{result.data?.targetId && <Link to={`${scopePath({ ...scope, environmentId: result.data.targetId })}/overview`}>Open restored environment</Link>}</QueryView>}</>}</QueryView>}<p>Advance the local clock three seconds to complete queued work. Cancellation needs acknowledgement. Review actual results before submitting a retry; successful restore categories remain committed.</p></section>;
}
