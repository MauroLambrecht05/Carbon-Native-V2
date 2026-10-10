import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { useState } from "react";
import { Feedback } from "../../components/Feedback";
import { scopeKey } from "../../framework/queries/scope-cache";
import { useSession } from "../../framework/session/SessionProvider";
import { useServices } from "../../framework/services/context";
import { unwrap, type ResolvedScope, type Scope } from "../../framework/services/contracts";
import type { BillingCommand, UsageKind } from "../../framework/services/operations-contracts";

const commandKey = () => crypto.randomUUID();
export function BillingScopePage({ scope, resolved }: { scope: Scope; resolved: ResolvedScope }) {
  const path = useLocation().pathname;
  if (path.endsWith("/settings/limits")) return <LimitsPage scope={scope} />;
  if (path.endsWith("/usage")) return <UsagePage scope={scope} />;
  return <BillingPage scope={scope} resolved={resolved} />;
}
function useBilling(scope: Scope) {
  const services = useServices(), { session } = useSession(), cache = useQueryClient();
  const key = [...scopeKey(session!.visibilityKey, scope), "billing"];
  const subscription = useQuery({ queryKey: [...key, "subscription"], queryFn: async ({ signal }) => unwrap(await services.billing.getSubscription({ scope, signal })) });
  const mutation = useMutation({ mutationFn: async ({ input, revision }: { input: BillingCommand; revision?: string }) => unwrap(await services.billing.command({ scope }, input, { idempotencyKey: commandKey(), expectedRevision: revision })), onSuccess: async () => { await cache.invalidateQueries({ queryKey: key }); } });
  return { services, key, subscription, mutation };
}
function BillingPage({ scope, resolved }: { scope: Scope; resolved: ResolvedScope }) {
  const { services, key, subscription, mutation } = useBilling(scope);
  const budgets = useQuery({ queryKey: [...key, "budgets"], queryFn: async ({ signal }) => unwrap(await services.billing.listBudgets({ scope, signal })) });
  const invoices = useQuery({ queryKey: [...key, "invoices"], queryFn: async ({ signal }) => unwrap(await services.billing.listInvoices({ scope, signal })) });
  const deletion = useQuery({ queryKey: [...key, "deletion"], queryFn: async ({ signal }) => unwrap(await services.billing.previewDeletion({ scope, signal })), enabled: resolved.permissions["organization.manage"].allowed });
  const freePreview = useQuery({ queryKey: [...key, "plan-preview", "free"], queryFn: async ({ signal }) => unwrap(await services.billing.previewPlan({ scope, signal }, "free")) });
  const [warning, setWarning] = useState("45"), [cap, setCap] = useState("60"), [kind, setKind] = useState<UsageKind>("build_minutes"), [providerEvent, setProviderEvent] = useState("fixture-provider-1"), [payment, setPayment] = useState("Visa •••• 4242 (fixture)"), [deleteConfirmation, setDeleteConfirmation] = useState("");
  if (subscription.isPending) return <p role="status">Loading subscription…</p>;
  if (subscription.error) return <Feedback error={subscription.error} retry={() => void subscription.refetch()} />;
  const sub = subscription.data, disabled = !resolved.permissions["billing.manage"].allowed ? resolved.permissions["billing.manage"].reason : undefined;
  const submit = (input: BillingCommand) => mutation.mutate({ input, revision: sub.revision });
  return <>
    <section><h2>Subscription</h2><p><strong>{sub.plan}</strong> · {sub.state} · period {sub.periodStart} to {sub.periodEnd}</p><p>Included build minutes: {sub.entitlements.buildMinutes}. Storage, function and egress prices are fictional fixture metadata.</p>{sub.pendingPlan && <p className="notice">Pending {sub.pendingPlan}. A return URL cannot activate it; only a simulated provider event can.</p>}
      {freePreview.data && <details><summary>Free-plan downgrade preview</summary><p>{freePreview.data.fictionalPrice} · effective at {freePreview.data.effective.replaceAll("_", " ")}</p>{freePreview.data.conflicts.length ? <ul>{freePreview.data.conflicts.map(x => <li key={x}>{x}</li>)}</ul> : <p>No current-usage conflicts.</p>}<button disabled={!!disabled || sub.plan !== "pro" || mutation.isPending} onClick={() => submit({ kind: "downgrade.schedule", plan: "free", acceptGracePolicy: true })}>Accept policy and schedule downgrade</button></details>}
      <div className="controls"><button disabled={!!disabled || mutation.isPending} title={disabled} onClick={() => submit({ kind: "checkout.start", plan: "pro" })}>Start mock Pro checkout</button><button disabled={!!disabled || sub.plan === "free" || mutation.isPending} title={disabled} onClick={() => submit({ kind: "subscription.cancel" })}>Cancel at period end</button><button disabled={!!disabled || sub.state !== "cancel_scheduled" || mutation.isPending} onClick={() => submit({ kind: "subscription.resume" })}>Resume subscription</button></div>
      <form onSubmit={e => { e.preventDefault(); submit({ kind: "provider.event", eventId: providerEvent, outcome: (new FormData(e.currentTarget).get("outcome") as "succeeded" | "failed" | "requires_action") }); }}><h3>Simulated provider event</h3><label>Event ID<input value={providerEvent} onChange={e => setProviderEvent(e.target.value)} required /></label><label>Outcome<select name="outcome"><option value="succeeded">succeeded</option><option value="failed">failed</option><option value="requires_action">requires action</option></select></label><button disabled={!!disabled || mutation.isPending}>Apply provider event</button></form>
      <form onSubmit={e => { e.preventDefault(); submit({ kind: "payment.update", label: payment }); }}><h3>Payment metadata</h3><label>Fixture label<input value={payment} onChange={e => setPayment(e.target.value)} required /></label><button disabled={!!disabled || mutation.isPending}>Update mock payment method</button><p>No payment provider or financial transaction is used.</p></form>
    </section>
    <section><h2>Budgets and hard caps</h2><form onSubmit={e => { e.preventDefault(); submit({ kind: "budget.save", usageKind: kind, warningAt: Number(warning), hardCap: cap ? Number(cap) : undefined }); }}><label>Resource<select value={kind} onChange={e => setKind(e.target.value as UsageKind)}><option value="build_minutes">Build minutes</option><option value="storage_bytes">Storage bytes</option><option value="function_invocations">Function invocations</option><option value="egress_bytes">Egress bytes</option></select></label><label>Warning at<input type="number" min="0" value={warning} onChange={e => setWarning(e.target.value)} required /></label><label>Hard cap (optional)<input type="number" min="1" value={cap} onChange={e => setCap(e.target.value)} /></label><button disabled={!!disabled || mutation.isPending}>Save budget policy</button></form>{budgets.data?.map(x => <p key={x.id}>{x.kind}: {x.current} / warning {x.warningAt} / cap {x.hardCap ?? "none"} · <strong>{x.state}</strong></p>)}<p>A hard cap blocks new charged work. Existing data and retained downloads are never silently removed.</p></section>
    <section><h2>Invoices</h2>{invoices.isPending ? <p>Loading invoices…</p> : invoices.error ? <Feedback error={invoices.error} /> : invoices.data.items.map(x => <p key={x.id}>{x.number} · {x.status} · {x.total} {x.currency} · <a download={`${x.number}.txt`} href={x.fixtureDownload}>Download local fixture</a></p>)}{invoices.data && !invoices.data.items.length && <p>No invoices.</p>}</section>
    {deletion.data && <section><h2>Organization deletion and retention preview</h2><p>Recovery window ends {deletion.data.recoveryEndsAt}.</p>{deletion.data.blockers.length ? <p role="alert">{deletion.data.blockers.join(" ")}</p> : <p>No active-operation blocker.</p>}<h3>Removed immediately</h3><ul>{deletion.data.immediatelyRemoved.map(x => <li key={x}>{x}</li>)}</ul><h3>Retained</h3><ul>{deletion.data.retained.map(x => <li key={x}>{x}</li>)}</ul><label>Type {deletion.data.organization}<input value={deleteConfirmation} onChange={e => setDeleteConfirmation(e.target.value)} /></label><button disabled={!!disabled || !!deletion.data.blockers.length || mutation.isPending} onClick={() => submit({ kind: "organization.delete.schedule", confirmation: deleteConfirmation })}>Schedule deletion</button><button disabled={!!disabled || mutation.isPending} onClick={() => submit({ kind: "organization.delete.cancel" })}>Cancel scheduled deletion</button><p>Scheduling disables charged writes during the local 7-day recovery window. It does not immediately erase retained audit or provenance.</p></section>}
    {mutation.error && <Feedback error={mutation.error} />}{mutation.data && <p role="status">{mutation.data.message}</p>}
  </>;
}
function UsagePage({ scope }: { scope: Scope }) {
  const { services, key } = useBilling(scope); const [project, setProject] = useState("");
  const query = useQuery({ queryKey: [...key, "usage", project], queryFn: async ({ signal }) => unwrap(await services.billing.listUsage({ scope, signal }, { projectId: project || undefined })) });
  return <section><h2>Current-period usage</h2><label>Project ID filter<input value={project} onChange={e => setProject(e.target.value)} /></label>{query.isPending ? <p>Loading usage…</p> : query.error ? <Feedback error={query.error} retry={() => void query.refetch()} /> : <table><thead><tr><th>Resource</th><th>Quantity</th><th>Classification</th><th>Project</th></tr></thead><tbody>{query.data.items.map(x => <tr key={x.id}><td>{x.kind}</td><td>{x.classification === "unavailable" ? "Unavailable" : x.quantity}</td><td>{x.classification}</td><td>{x.projectId ?? "organization"}</td></tr>)}</tbody></table>}<p>Queue wait is excluded from build minutes. Metered records carry correlation IDs; adjustments remain separate immutable events.</p></section>;
}
function LimitsPage({ scope }: { scope: Scope }) {
  const services = useServices(), { session } = useSession(); const query = useQuery({ queryKey: [...scopeKey(session!.visibilityKey, scope), "limits"], queryFn: async ({ signal }) => unwrap(await services.billing.getLimits({ scope, signal })) });
  return <section><h2>Environment limits and consequences</h2>{query.isPending ? <p>Loading limits…</p> : query.error ? <Feedback error={query.error} retry={() => void query.refetch()} /> : <table><thead><tr><th>Resource</th><th>Used</th><th>Limit</th><th>State</th><th>Consequence</th></tr></thead><tbody>{query.data.quotas.map(x => <tr key={x.name}><td>{x.name}</td><td>{x.used}</td><td>{x.limit}</td><td>{x.state}</td><td>{x.consequence}</td></tr>)}</tbody></table>}<p>Limits are organization entitlements projected onto this environment. Values are mock fixtures, not commercial commitments.</p></section>;
}
