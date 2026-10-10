import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { useServices } from "../../framework/services/context";
import { unwrap, type BrowserServices, type RequestContext, type Result, type Scope } from "../../framework/services/contracts";
import type { LocalDownload } from "../../framework/services/data-contracts";
import { scopeKey } from "../../framework/queries/scope-cache";
import { useSession } from "../../framework/session/SessionProvider";
import { CommandForm, type Field } from "../identity/Forms";
import { Pager } from "../identity/IdentityPages";

export function useDataQuery<T>(scope: Scope | undefined, key: unknown[], getter: (services: BrowserServices, context: RequestContext) => Promise<Result<T>>, enabled = true) {
  const services = useServices(), { session } = useSession();
  return useQuery({ queryKey: [...scopeKey(session?.visibilityKey ?? "visitor", scope), "data-auth", ...key], queryFn: async ({ signal }) => unwrap(await getter(services, { scope: scope!, signal })), enabled });
}
export function QueryView({ query, children }: { query: { isPending: boolean; error: unknown; refetch: () => unknown }; children: ReactNode }) { return query.isPending ? <p role="status">Loading authorized resource…</p> : query.error ? <Feedback error={query.error} retry={() => void query.refetch()} /> : <>{children}</>; }
export const jsonField = (name: string, label: string, value: unknown): Field => ({ name, label, type: "textarea", value: JSON.stringify(value, null, 2) });
export const confirmation: Field = { name: "production", label: "Production confirmation: type the environment ID if required", required: false };
export const split = (value: string) => value.split(",").map(v => v.trim()).filter(Boolean);
export function useDataParams() {
  const [params, setParams] = useSearchParams();
  const set = (name: string, value: string) => { const next = new URLSearchParams(params); value ? next.set(name, value) : next.delete(name); if (name !== "cursor") next.delete("cursor"); setParams(next); };
  return { params, set, cursor: params.get("cursor") ?? undefined, pager: (next: string | null) => <Pager cursor={params.get("cursor") ?? undefined} next={next} change={v => set("cursor", v ?? "")} /> };
}
export function Inspect({ value }: { value: unknown }) { return <pre>{JSON.stringify(value, null, 2)}</pre>; }
export function Download({ get, title = "Download local fixture", disabled }: { get: () => Promise<Result<LocalDownload>>; title?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  return <><button disabled={busy || disabled} onClick={async () => { setBusy(true); setError(undefined); try { const result = unwrap(await get()); const url = URL.createObjectURL(new Blob([result.text], { type: result.contentType })); const a = document.createElement("a"); a.href = url; a.download = result.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e) { setError(e); } finally { setBusy(false); } }}>{busy ? "Preparing…" : title}</button>{error !== undefined && <Feedback error={error} />}</>;
}
export function DataJobPanel({ scope, id }: { scope: Scope; id?: string }) {
  const { data } = useServices();
  const query = useDataQuery(scope, ["operation", id], (s, c) => s.operations.get(c, id!), !!id);
  const result = useDataQuery(scope, ["job-result", id, query.data?.revision], (s, c) => s.data.getJobResult(c, id!), !!id && ["succeeded", "failed"].includes(query.data?.state ?? ""));
  if (!id) return null;
  return <section><h2>Data operation {id}</h2><QueryView query={query}>{query.data && <><p>{query.data.state} · {query.data.revision}</p><progress value={query.data.completedSteps} max={query.data.totalSteps} /><p>{query.data.error?.message}</p>{["queued", "running"].includes(query.data.state) && <CommandForm title="Request cancellation" revision={query.data.revision} submit={(_, o) => data.cancelJob({ scope }, id, o)} />}<p>Closing this panel does not cancel work. A committed transaction cannot be rolled back by cancellation.</p></>}</QueryView>{result.data && <><p>{result.data.message}</p>{result.data.errors.length > 0 && <Inspect value={result.data.errors} />}{result.data.download && <Download get={async () => { const r = await data.getJobResult({ scope }, id); return r.ok ? { ok: true, value: r.value.download! } : r; }} />}</>}{result.error && <Feedback error={result.error} />}</section>;
}
