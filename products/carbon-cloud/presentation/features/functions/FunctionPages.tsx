import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { resolveRoute, scopePath } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import { unwrap, type ResolvedScope, type Scope } from "../../framework/services/contracts";
import type { CloudFunction, Deployment, FunctionCommand, FunctionConfig, FunctionSchedule, Invocation, InvocationIdentity } from "../../framework/services/function-contracts";
import { CommandForm, choices, type Field } from "../identity/Forms";
import { Pager } from "../identity/IdentityPages";
import { confirmation, Inspect, jsonField, QueryView, useDataParams, useDataQuery } from "../data/shared";
import { denied } from "../extensions/shared";

type Props = { scope: Scope; resolved: ResolvedScope };
const defaultConfig: FunctionConfig = { handler: "echo", authorization: "app-session", timeoutMs: 5000, memoryMb: 128, concurrency: 2, secrets: [] };
const source = "// Mock source draft. This text is never evaluated.\n// Select a named fixture handler in configuration.\nexport default async request => ({ status: 200, body: request.body });";
function FunctionForm({ scope, title, fields = [], revision, command, disabled, after }: { scope: Scope; title: string; fields?: Field[]; revision?: string; command: (v: Record<string, string>) => FunctionCommand; disabled?: string; after?: (id?: string, operation?: string, targetScope?: Scope) => void }) {
  const { functions } = useServices();
  return <CommandForm title={title} fields={[...fields, confirmation]} revision={revision} disabled={disabled} submit={(v, o) => functions.command({ scope }, command(v), v.production, o)} after={r => after?.(r.resourceId, r.operationId, r.operation?.scope)} />;
}
export function FunctionPages(props: Props) {
  const location = useLocation(), params = resolveRoute(location.pathname)?.params ?? {};
  const available = props.resolved.bindings.some(b => b.owner === "functions" && b.state === "ready");
  if (!available) return <section><p>Functions need a ready service binding.</p><Link to={`${scopePath(props.scope)}/overview`}>Enable Functions in environment overview</Link></section>;
  return <><p>Local function fixtures. Source is stored as text. HTTP invocations use this console; no endpoint is contacted.</p><Link to={`${scopePath(props.scope)}/functions`}>All functions</Link>{params.functionId ? <FunctionDetail key={`${params.functionId}:${params.invocationId ?? ""}:${location.pathname.endsWith("/schedules")}`} {...props} id={params.functionId} invocationId={params.invocationId} schedules={location.pathname.endsWith("/schedules")} /> : <FunctionList {...props} />}</>;
}
function FunctionList({ scope, resolved }: Props) {
  const { params, set, cursor, pager } = useDataParams(), navigate = useNavigate();
  const query = useDataQuery(scope, ["functions", cursor, params.get("name")], (s, c) => s.functions.list(c, { cursor, limit: 10, filter: { name: params.get("name") ?? "" }, sort: "name" }));
  const limits = useDataQuery(scope, ["function-limits"], (s, c) => s.functions.limits(c));
  return <><label>Search functions<input value={params.get("name") ?? ""} onChange={e => set("name", e.target.value)} /></label><QueryView query={query}>{query.data && <><ul>{query.data.items.map(f => <li key={f.id}><Link to={`${scopePath(scope)}/functions/${f.id}`}>{f.name}</Link> · {f.status} · {f.activeDeploymentId ?? "Not deployed"}</li>)}</ul>{!query.data.total && <p>No functions yet. Create a draft from the fixture or a repository path.</p>}{pager(query.data.nextCursor)}</>}</QueryView>
    <FunctionForm scope={scope} title="Create function draft" disabled={denied(resolved, "resources.configure")} fields={[{ name: "name", label: "Function name", value: "hello" }, { name: "source", label: "Source fixture (text only)", type: "textarea", value: source, required: false }, { name: "path", label: "Repository path (optional)", required: false }, jsonField("config", "Configuration JSON", defaultConfig)]} command={v => ({ kind: "create", name: v.name, source: v.source, repositoryPath: v.path, config: JSON.parse(v.config) })} after={id => navigate(`${scopePath(scope)}/functions/${id}`)} />
    <QueryView query={limits}><h2>Execution contract and limits</h2><Inspect value={limits.data} /></QueryView><ConfigHelp scope={scope} />
  </>;
}
function ConfigHelp({ scope }: { scope: Scope }) {
  const secrets = useDataQuery(scope, ["function-secrets"], (s, c) => s.configuration.listSecrets(c, { limit: 100 }));
  return <details><summary>Configuration and secret binding guide</summary><p>Handlers: echo, user-error, infrastructure-error, timeout, read-rows, read-blob. Authorization: anonymous, app-session, service-credential. Memory: 128, 256 or 512 MB; timeout: 100–30000 ms; concurrency: 1–4.</p><p>Resource read fixtures need a declared grant: <code>{'{"kind":"table","tableId":"…"}'}</code> or <code>{'{"kind":"blob","bucketId":"…","key":"…"}'}</code>. App identities use their row/blob policies. Service credentials need functions:invoke and data:read. No platform administrator credential is inherited.</p><p>Secret references use <code>{'{"name":"API_KEY","secretId":"…"}'}</code>. Deployments pin versions. Replacing a secret affects later deployments; existing snapshots keep their versions. Values are never returned or interpolated into source or logs.</p><Link to={`${scopePath(scope)}/settings/secrets`}>Manage secret metadata</Link><QueryView query={secrets}><ul>{secrets.data?.items.map(s => <li key={s.id}>{s.name} · {s.id} · version {s.version}</li>)}</ul></QueryView></details>;
}
function FunctionDetail({ scope, resolved, id, invocationId, schedules }: Props & { id: string; invocationId?: string; schedules: boolean }) {
  const query = useDataQuery(scope, ["function", id], (s, c) => s.functions.get(c, id));
  return <QueryView query={query}>{query.data && <><h2>{query.data.name} · {query.data.status}</h2><nav><Link to={`${scopePath(scope)}/functions/${id}`}>Source, deployments and invocations</Link><Link to={`${scopePath(scope)}/functions/${id}/schedules`}>Schedules</Link></nav>{invocationId ? <InvocationDetail scope={scope} resolved={resolved} fn={query.data} id={invocationId} /> : schedules ? <Schedules scope={scope} resolved={resolved} fn={query.data} /> : <FunctionWorkspace scope={scope} resolved={resolved} fn={query.data} />}</>}</QueryView>;
}
function FunctionWorkspace({ scope, resolved, fn }: Props & { fn: CloudFunction }) {
  const { functions } = useServices(), navigate = useNavigate(), [operation, setOperation] = useState<string>();
  const [params, setParams] = useSearchParams(), cursor = params.get("deploymentCursor") ?? undefined;
  const query = useDataQuery(scope, ["function-deployments", fn.id, fn.revision, cursor], (s, c) => s.functions.deployments(c, fn.id, { limit: 10, cursor }));
  const blocked = fn.status === "deleted" ? "Deleted function history is read-only." : denied(resolved, "resources.configure");
  return <><p>Active deployment: {fn.activeDeploymentId ?? "None"}. Draft revision: {fn.draft.revision}.</p><DraftEditor scope={scope} resolved={resolved} fn={fn} />
    <ConfigHelp scope={scope} /><FunctionForm scope={scope} title="Deploy saved draft" revision={fn.revision} disabled={blocked} fields={[{ name: "fail", label: "Simulate validation failure", value: "false", options: choices(["false", "true"]) }]} command={v => ({ kind: "deploy", id: fn.id, simulateFailure: v.fail === "true" })} after={(_, op) => setOperation(op)} />
    <DeploymentJobs scope={scope} selected={operation ?? params.get("operation") ?? undefined} />
    <QueryView query={query}><h2>Immutable deployments</h2>{!query.data?.total && <p>No successful deployments yet.</p>}{query.data?.items.map(d => <DeploymentCard key={d.id} scope={scope} resolved={resolved} fn={fn} deployment={d} />)}{query.data && <Pager cursor={cursor} next={query.data.nextCursor} change={value => { const next = new URLSearchParams(params); value ? next.set("deploymentCursor", value) : next.delete("deploymentCursor"); setParams(next); }} />}</QueryView>
    <CommandForm title="Invoke active deployment" sensitive revision={fn.revision} disabled={fn.status !== "enabled" || !fn.activeDeploymentId ? "Enable and deploy the function first." : denied(resolved, "data.write")} fields={[jsonField("payload", "JSON request body", { message: "Hello" }), jsonField("headers", "Headers (only content-type and x-request-tag retained)", { "content-type": "application/json" }), { name: "identity", label: "Invocation identity", value: "app-session", options: choices(["anonymous", "app-session", "service-credential"]) }, { name: "credential", label: "Backend credential ID (service identity only)", required: false }, { name: "businessKey", label: "Business idempotency key (optional)", required: false }, confirmation]} submit={(v, o) => functions.invoke({ scope }, fn.id, { payload: JSON.parse(v.payload), headers: JSON.parse(v.headers), identity: v.identity === "service-credential" ? { mode: "service-credential", credentialId: v.credential } : { mode: v.identity } as InvocationIdentity, businessKey: v.businessKey || undefined }, v.production, o)} after={r => navigate(`${scopePath(scope)}/functions/${fn.id}/invocations/${r.resourceId}`)}><p>The selected identity must match the deployed authorization policy. App mode uses the active verified app session. Service mode selects a local credential fixture by ID; it is not a real credential exchange. Secret-like payload fields and unapproved headers are redacted before storage and handling. Response shape: JSON body, status code, request ID, deployment and duration.</p><Link to={`${scopePath(scope)}/auth/settings`}>Sign in as an app user</Link><Link to={`${scopePath(scope)}/settings/api`}>Manage backend credentials</Link></CommandForm>
    <InvocationList scope={scope} fn={fn} />
    <FunctionForm scope={scope} title="Change function status" revision={fn.revision} disabled={blocked} fields={[{ name: "status", label: "New status", value: fn.status === "enabled" ? "disabled" : "enabled", options: choices(["enabled", "disabled", "deleted"]) }, { name: "confirm", label: `Confirm function name: ${fn.name}` }]} command={v => ({ kind: "status", id: fn.id, status: v.status as "enabled" | "disabled" | "deleted", confirmation: v.confirm })} />
    <p>Disable/delete stops schedules, refuses new work and requests cancellation of pending work. History remains available until an explicit retention policy is implemented. Re-enabling does not resume schedules automatically.</p>
  </>;
}
function DraftEditor({ scope, resolved, fn }: Props & { fn: CloudFunction }) {
  const { functions } = useServices(), cache = useQueryClient();
  const [text, setText] = useState(fn.draft.source), [path, setPath] = useState(fn.draft.repositoryPath), [config, setConfig] = useState(JSON.stringify(fn.draft.config, null, 2));
  const [production, setProduction] = useState(""), [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<unknown>(), [saved, setSaved] = useState(fn.draft.savedAt);
  const revision = useRef(fn.revision), generation = useRef(0), alive = useRef(true), controller = useRef<AbortController>();
  const disabled = fn.status === "deleted" ? "Deleted function history is read-only." : denied(resolved, "resources.configure");
  const confirmed = resolved.environment?.kind !== "production" || resolved.environment.requireProductionConfirmation === false || production === scope.environmentId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (!dirty && !saving) { revision.current = fn.revision; setText(fn.draft.source); setPath(fn.draft.repositoryPath); setConfig(JSON.stringify(fn.draft.config, null, 2)); setSaved(fn.draft.savedAt); } }, [fn.revision]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    const leave = (event: MouseEvent) => { if (dirty && (event.target as Element)?.closest?.("a") && !window.confirm("This function draft has unsaved changes. Leave the editor?")) { event.preventDefault(); event.stopPropagation(); } };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [dirty]);
  useEffect(() => {
    if (!dirty || saving || disabled || !confirmed || error) return;
    const timer = setTimeout(() => { void save(); }, 900); return () => clearTimeout(timer);
  }, [text, path, config, dirty, saving, disabled, confirmed, error]);
  function edit(set: (s: string) => void, value: string) { generation.current++; set(value); setDirty(true); setError(undefined); }
  async function save() {
    const version = generation.current; setSaving(true); controller.current = new AbortController();
    try {
      unwrap(await functions.command({ scope, signal: controller.current.signal }, { kind: "save", id: fn.id, source: text, repositoryPath: path, config: JSON.parse(config) }, production, { expectedRevision: revision.current, idempotencyKey: crypto.randomUUID() }));
      const fresh = unwrap(await functions.get({ scope, signal: controller.current.signal }, fn.id));
      if (alive.current) { revision.current = fresh.revision; setSaved(fresh.draft.savedAt); if (version === generation.current) setDirty(false); }
      await cache.invalidateQueries();
    } catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setSaving(false); }
  }
  return <section><h2>Source draft</h2><p>Autosaves after editing pauses. Saved drafts do not change deployments. {saving ? "Saving draft…" : dirty ? "Unsaved changes" : `Saved ${saved}`}</p><fieldset disabled={!!disabled}><label>Source (text only)<textarea rows={10} maxLength={64000} value={text} onChange={e => edit(setText, e.target.value)} /></label><label>Repository path<input value={path} onChange={e => edit(setPath, e.target.value)} /></label><label>Configuration JSON<textarea rows={12} value={config} onChange={e => edit(setConfig, e.target.value)} /></label>{resolved.environment?.kind === "production" && <label>Production autosave confirmation: type {scope.environmentId}<input value={production} onChange={e => setProduction(e.target.value)} /></label>}<button disabled={!dirty || saving || !confirmed} onClick={() => void save()}>Save draft now</button></fieldset>{disabled && <p>{disabled}</p>}{error !== undefined && <><Feedback error={error} /><button onClick={() => { revision.current = fn.revision; setError(undefined); }}>Use latest revision ({fn.revision}) after comparing changes</button><Inspect value={fn.draft} /></>}</section>;
}
function DeploymentJobs({ scope, selected }: { scope: Scope; selected?: string }) {
  const { functions } = useServices(), [chosen, setChosen] = useState<string>();
  const [params, setParams] = useSearchParams(), cursor = params.get("operationCursor") ?? undefined;
  const list = useDataQuery(scope, ["function-operations", cursor], (s, c) => s.operations.list(c, { limit: 20, cursor }));
  const id = chosen ?? selected, query = useDataQuery(scope, ["function-operation", id], (s, c) => s.operations.get(c, id!), !!id);
  return <section><h2>Deployment progress</h2><QueryView query={list}><select aria-label="Deployment operation" value={id ?? ""} onChange={e => { setChosen(e.target.value); const next = new URLSearchParams(params); next.set("operation", e.target.value); setParams(next); }}><option value="">Choose deployment operation</option>{list.data?.items.filter(o => o.kind === "function.deploy").map(o => <option key={o.id} value={o.id}>{o.id} · {o.state}</option>)}</select>{list.data && <Pager cursor={cursor} next={list.data.nextCursor} change={value => { const next = new URLSearchParams(params); value ? next.set("operationCursor", value) : next.delete("operationCursor"); setParams(next); }} />}</QueryView>{id && <QueryView query={query}>{query.data && <><Inspect value={query.data} />{["queued", "running"].includes(query.data.state) && <CommandForm title="Cancel deployment" revision={query.data.revision} fields={[confirmation]} submit={(v, o) => functions.cancelDeployment({ scope }, id, v.production, o)} />}</>}</QueryView>}<p>Packaging, validation and activation take three mock seconds. Advance the mock clock or leave it running. Reloading does not discard queued work.</p></section>;
}
function DeploymentCard({ scope, resolved, fn, deployment: d }: Props & { fn: CloudFunction; deployment: Deployment }) {
  const navigate = useNavigate();
  return <details><summary>{d.id} · {d.sourceDigest} {fn.activeDeploymentId === d.id ? "· active" : ""}</summary><Inspect value={d} />
    <FunctionForm scope={scope} title={`Activate ${d.id}`} revision={fn.revision} disabled={denied(resolved, "resources.configure")} command={() => ({ kind: "rollback", id: fn.id, deploymentId: d.id })} />
    <p>Rollback changes the active pointer. It cannot undo previous business effects.</p>
    <FunctionForm scope={scope} title={`Promote ${d.id}`} revision={fn.revision} disabled={denied(resolved, "resources.configure")} fields={[{ name: "target", label: "Target environment ID" }, { name: "function", label: "Existing target function ID (optional)", required: false }, { name: "revision", label: "Existing target function revision (if selected)", required: false }, jsonField("config", "Reviewed target configuration (map secret and resource IDs to target)", { ...d.config, secrets: [] }), { name: "reviewed", label: "Source digest, target configuration and secret bindings reviewed", value: "false", options: choices(["false", "true"]) }]} command={v => ({ kind: "promote", id: fn.id, deploymentId: d.id, targetEnvironmentId: v.target, targetFunctionId: v.function || undefined, targetRevision: v.revision || undefined, config: JSON.parse(v.config), reviewed: v.reviewed === "true" })} after={(targetId, op, targetScope) => { if (op && targetId && targetScope) navigate(`${scopePath(targetScope)}/functions/${targetId}?operation=${op}`); }} />
    <p>Promotion creates a target deployment with the same source digest. Inspect target deployment progress in that environment. All target permissions and production confirmation are rechecked.</p>
  </details>;
}
function InvocationList({ scope, fn }: { scope: Scope; fn: CloudFunction }) {
  const { params, set, cursor, pager } = useDataParams();
  const status = params.get("status") ?? "", trigger = params.get("trigger") ?? "", since = params.get("since") ?? "", until = params.get("until") ?? "";
  const query = useDataQuery(scope, ["function-invocations", fn.id, status, trigger, since, until, cursor], (s, c) => s.functions.invocations(c, fn.id, { status: status as Invocation["state"] || undefined, trigger: trigger as Invocation["trigger"] || undefined, since: since || undefined, until: until || undefined, cursor, limit: 10 }));
  return <section><h2>Invocation history</h2><label>Status<select value={status} onChange={e => set("status", e.target.value)}>{["", "queued", "running", "succeeded", "failed", "timed_out", "cancelled"].map(s => <option key={s} value={s}>{s || "All"}</option>)}</select></label><label>Trigger<select value={trigger} onChange={e => set("trigger", e.target.value)}>{["", "http", "schedule", "retry"].map(s => <option key={s} value={s}>{s || "All"}</option>)}</select></label><label>Since (ISO timestamp)<input value={since} onChange={e => set("since", e.target.value)} /></label><label>Until (ISO timestamp)<input value={until} onChange={e => set("until", e.target.value)} /></label><QueryView query={query}>{query.data && <><ul>{query.data.items.map(i => <li key={i.id}><Link to={`${scopePath(scope)}/functions/${fn.id}/invocations/${i.id}`}>{i.id}</Link> · {i.state} · {i.trigger} · {i.createdAt} · {i.durationMs ?? "—"} ms</li>)}</ul>{!query.data.total && <p>No invocations match these filters.</p>}{pager(query.data.nextCursor)}</>}</QueryView></section>;
}
function InvocationDetail({ scope, resolved, fn, id }: Props & { fn: CloudFunction; id: string }) {
  const { functions } = useServices(), navigate = useNavigate(), [content, setContent] = useState(false);
  const query = useDataQuery(scope, ["function-invocation", fn.id, id, content], (s, c) => s.functions.invocation(c, fn.id, id, content));
  return <section><h2>Invocation {id}</h2><label><input type="checkbox" checked={content} disabled={!resolved.permissions["data.read"].allowed} onChange={e => setContent(e.target.checked)} />Include bounded, redacted request, response and logs (data.read required)</label><QueryView query={query}>{query.data && <><Inspect value={query.data} />{["queued", "running"].includes(query.data.state) && <CommandForm title="Request invocation cancellation" revision={query.data.revision} disabled={denied(resolved, "data.write")} fields={[confirmation]} submit={(v, o) => functions.cancel({ scope }, fn.id, id, v.production, o)} />}{["failed", "timed_out", "cancelled"].includes(query.data.state) && <CommandForm title="Retry original deployment" revision={query.data.revision} disabled={denied(resolved, "data.write") ?? denied(resolved, "data.read")} fields={[confirmation]} submit={(v, o) => functions.retry({ scope }, fn.id, id, v.production, o)} after={r => navigate(`${scopePath(scope)}/functions/${fn.id}/invocations/${r.resourceId}`)}><p>This creates a new invocation linked to the original. The business key is forwarded; handlers must implement deduplication. Delivery can repeat and earlier side effects may already have occurred.</p></CommandForm>}</>}</QueryView></section>;
}
function Schedules({ scope, resolved, fn }: Props & { fn: CloudFunction }) {
  const { params, cursor, pager } = useDataParams();
  const query = useDataQuery(scope, ["function-schedules", fn.id, cursor, params.get("name")], (s, c) => s.functions.schedules(c, fn.id, { cursor, limit: 10 }));
  const [cron, setCron] = useState("*/5 * * * *"), [timezone, setTimezone] = useState("UTC");
  const preview = useDataQuery(scope, ["function-schedule-preview", cron, timezone], (s, c) => s.functions.previewSchedule(c, cron, timezone));
  return <><p>Schedules require a backend credential and a deployed service-credential policy. Credentials are rechecked on every run. Missed runs can be skipped or coalesced once. Overlap can be skipped or admitted to the bounded concurrency queue.</p><label>Preview cron<input value={cron} onChange={e => setCron(e.target.value)} /></label><label>Preview IANA timezone<input value={timezone} onChange={e => setTimezone(e.target.value)} /></label><QueryView query={preview}><Inspect value={preview.data} /></QueryView><ScheduleForm scope={scope} resolved={resolved} fn={fn} /><QueryView query={query}>{query.data && <>{!query.data.total && <p>No schedules yet.</p>}{query.data.items.map(s => <details key={s.id}><summary>{s.name} · {s.enabled ? "enabled" : "disabled"} · next {s.nextRunAt} · {s.lastOutcome ?? "No runs"}</summary><Inspect value={s} /><ScheduleForm scope={scope} resolved={resolved} fn={fn} schedule={s} /><FunctionForm scope={scope} title={`Delete schedule ${s.name}`} revision={s.revision} disabled={denied(resolved, "resources.configure")} command={() => ({ kind: "schedule.delete", id: fn.id, scheduleId: s.id })} /></details>)}{pager(query.data.nextCursor)}</>}</QueryView><Link to={`${scopePath(scope)}/functions/${fn.id}`}>Open invocation history</Link></>;
}
function ScheduleForm({ scope, resolved, fn, schedule: s }: Props & { fn: CloudFunction; schedule?: FunctionSchedule }) {
  return <FunctionForm scope={scope} title={s ? `Save schedule ${s.name}` : "Create schedule"} revision={s?.revision ?? fn.revision} disabled={denied(resolved, "resources.configure")} fields={[{ name: "name", label: "Schedule name", value: s?.name ?? "every-five-minutes" }, { name: "cron", label: "Cron", value: s?.cron ?? "*/5 * * * *" }, { name: "timezone", label: "IANA timezone", value: s?.timezone ?? "UTC" }, { name: "credential", label: "Backend credential ID", value: s?.credentialId }, { name: "enabled", label: "Enabled", value: String(s?.enabled ?? true), options: choices(["true", "false"]) }, { name: "missed", label: "Missed-run policy", value: s?.missed ?? "skip", options: choices(["skip", "catch-up-once"]) }, { name: "overlap", label: "Overlap policy", value: s?.overlap ?? "skip", options: choices(["skip", "allow"]) }]} command={v => ({ kind: "schedule.save", id: fn.id, scheduleId: s?.id, name: v.name, cron: v.cron, timezone: v.timezone, credentialId: v.credential, enabled: v.enabled === "true", missed: v.missed as FunctionSchedule["missed"], overlap: v.overlap as FunctionSchedule["overlap"] })} />;
}
