import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { resolveRoute, scopePath } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import type { ResolvedScope, Scope } from "../../framework/services/contracts";
import type { LiveExecution, LiveFunctionService, LiveSchedule } from "../../framework/services/live-function-contracts";
import { CommandForm, type Field } from "../identity/Forms";
import { Inspect, QueryView, useDataParams, useDataQuery } from "../data/shared";

// Functions against Carbon Cloud. Every page here shows what the service holds and offers the commands it has:
// deploy a revision, activate one, invoke, follow an execution and read what it printed, and schedule.

type Props = { scope: Scope; resolved: ResolvedScope };
const OPEN = ["queued", "running"];
const when = (value: string | null) => (value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "never");
const why = (resolved: ResolvedScope, permission: "resources.configure" | "data.write") => (resolved.permissions[permission].allowed ? undefined : resolved.permissions[permission].reason ?? "Your role does not include this.");

function useLive(): LiveFunctionService {
  const service = useServices().liveFunctions;
  if (!service) throw new Error("Functions are not available in this composition.");
  return service;
}

export function LiveFunctionPages(props: Props) {
  const location = useLocation(); const route = resolveRoute(location.pathname); const params = route?.params ?? {};
  const base = `${scopePath(props.scope)}/functions`;
  return (
    <section>
      <p>Functions run on Carbon Cloud's workers. Deploying stores a new revision of the code; an execution always runs the revision it was created with.</p>
      <Link to={base}>All functions</Link>
      {params.invocationId ? <Execution {...props} functionId={params.functionId!} executionId={params.invocationId} />
        : params.functionId && location.pathname.endsWith("/schedules") ? <Schedules {...props} functionId={params.functionId} />
        : params.functionId ? <FunctionDetail key={params.functionId} {...props} functionId={params.functionId} />
        : <FunctionList {...props} />}
    </section>
  );
}

function FunctionList({ scope, resolved }: Props) {
  const live = useLive(); const navigate = useNavigate(); const { cursor, pager } = useDataParams();
  const query = useDataQuery(scope, ["live-functions", cursor], (_services, context) => live.list(context, { cursor, limit: 25 }));
  const base = `${scopePath(scope)}/functions`;
  return (
    <>
      <h2>Functions</h2>
      <QueryView query={query}>
        {query.data && !query.data.items.length && <p>No functions in this environment yet.</p>}
        <ul>{query.data?.items.map(item => (
          <li key={item.id}><Link to={`${base}/${item.id}`}>{item.name}</Link> · {item.state} · revision {item.activeRevision} of {item.latestRevision}</li>
        ))}</ul>
        {query.data && pager(query.data.nextCursor)}
      </QueryView>
      <DeployForm scope={scope} title="Deploy a new function" disabled={why(resolved, "resources.configure")} after={id => id && navigate(`${base}/${id}`)} />
    </>
  );
}

const codeField = (value = "export default async (input) => {\n  return { received: input };\n};\n"): Field => ({ name: "code", label: "Code: one ES module whose default export is called with the input", type: "textarea", value, maxLength: 262144 });
const deployFields = (name?: string, code?: string, secrets = "", timeout = "30"): Field[] => [
  ...(name === undefined ? [{ name: "name", label: "Name: lower-case letters, digits and dashes", maxLength: 63 }] : []),
  codeField(code), { name: "secrets", label: "Secret names, comma-separated. Each must exist in this environment", value: secrets, required: false },
  { name: "timeout", label: "Time limit in seconds, 1 to 300", value: timeout, type: "number" },
];
const names = (value: string) => value.split(",").map(item => item.trim()).filter(Boolean);

function DeployForm({ scope, title, name, code, secrets, timeout, disabled, after }: { scope: Scope; title: string; name?: string; code?: string; secrets?: string; timeout?: string; disabled?: string; after?: (id?: string) => void }) {
  const live = useLive();
  return <CommandForm title={title} fields={deployFields(name, code, secrets, timeout)} disabled={disabled} after={receipt => after?.(receipt.resourceId)}
    submit={(values, options) => live.deploy({ scope }, { name: name ?? values.name!, code: values.code!, secretNames: names(values.secrets ?? ""), timeoutSeconds: Number(values.timeout) }, options)} />;
}

function FunctionDetail({ scope, resolved, functionId }: Props & { functionId: string }) {
  const live = useLive(); const navigate = useNavigate(); const { cursor, pager } = useDataParams(); const [shown, setShown] = useState<number>();
  const base = `${scopePath(scope)}/functions/${functionId}`;
  const query = useDataQuery(scope, ["live-function", functionId], (_services, context) => live.get(context, functionId));
  const executions = useDataQuery(scope, ["live-executions", functionId, cursor], (_services, context) => live.executions(context, functionId, { cursor, limit: 25 }));
  const code = useDataQuery(scope, ["live-function-code", functionId, shown], (_services, context) => live.code(context, functionId, shown!), shown !== undefined);
  const fn = query.data?.function; const active = query.data?.revisions.find(revision => revision.number === fn?.activeRevision);
  const configure = why(resolved, "resources.configure"); const run = why(resolved, "data.write");
  return (
    <QueryView query={query}>
      {fn && (
        <>
          <h2>{fn.name}</h2>
          <p>{fn.state === "active" ? "Active" : "Disabled: it cannot be invoked, and its schedules skip their slots."} · running revision {fn.activeRevision} of {fn.latestRevision}</p>
          <Link to={`${base}/schedules`}>Schedules</Link>

          <h3>Revisions</h3>
          <p>A revision never changes. Deploying adds one and makes it the active one; activating an earlier one is how to go back.</p>
          <ul>{query.data!.revisions.map(revision => (
            <li key={revision.number}>
              Revision {revision.number}{revision.number === fn.activeRevision ? " (active)" : ""} · time limit {revision.timeoutSeconds}s · secrets: {revision.secretNames.join(", ") || "none"} · {when(revision.createdAt)}
              {" "}<button type="button" disabled={!!configure} onClick={() => setShown(revision.number)}>Show code</button>
            </li>
          ))}</ul>
          {shown !== undefined && <QueryView query={code}><h4>Code of revision {shown}</h4><pre>{code.data}</pre></QueryView>}
          <CommandForm title="Activate a revision" revision={fn.revision} disabled={configure} fields={[{ name: "number", label: "Revision number", type: "number", value: String(fn.activeRevision) }]}
            submit={(values, options) => live.command({ scope }, functionId, { kind: "activate", revision: Number(values.number) }, options)} />
          <DeployForm scope={scope} title="Deploy a new revision" name={fn.name} secrets={active?.secretNames.join(", ")} timeout={String(active?.timeoutSeconds ?? 30)} disabled={configure} />
          <CommandForm title={fn.state === "active" ? "Disable this function" : "Enable this function"} revision={fn.revision} disabled={configure}
            submit={(_values, options) => live.command({ scope }, functionId, { kind: fn.state === "active" ? "disable" : "enable" }, options)} />

          <h3>Run it</h3>
          <CommandForm title="Invoke" disabled={run ?? (fn.state === "active" ? undefined : "This function is disabled.")} fields={[{ name: "input", label: "Input, as JSON", type: "textarea", value: "null" }]}
            after={receipt => receipt.resourceId && navigate(`${base}/invocations/${receipt.resourceId}`)}
            submit={(values, options) => { let input: unknown; try { input = JSON.parse(values.input || "null"); } catch { return Promise.resolve({ ok: false as const, error: { code: "validation" as const, message: "The input is not valid JSON.", requestId: "" } }); } return live.invoke({ scope }, functionId, input, options); }} />

          <h3>Executions</h3>
          <QueryView query={executions}>
            {executions.data && !executions.data.items.length && <p>This function has not run yet.</p>}
            <ul>{executions.data?.items.map(item => <li key={item.id}><Link to={`${base}/invocations/${item.id}`}>{when(item.createdAt)}</Link> · {describe(item)}</li>)}</ul>
            {executions.data && pager(executions.data.nextCursor)}
          </QueryView>
        </>
      )}
    </QueryView>
  );
}

const describe = (item: LiveExecution) => `${item.state}${item.errorCategory ? ` (${item.errorCategory})` : ""} · revision ${item.revisionNumber} · ${item.trigger}${item.attempt > 1 ? ` · attempt ${item.attempt}` : ""}`;

function Execution({ scope, resolved, functionId, executionId }: Props & { functionId: string; executionId: string }) {
  const live = useLive(); const navigate = useNavigate(); const base = `${scopePath(scope)}/functions/${functionId}`;
  const query = useDataQuery(scope, ["live-execution", executionId], (_services, context) => live.execution(context, executionId));
  const item = query.data; const open = item ? OPEN.includes(item.state) : false;
  const logs = useDataQuery(scope, ["live-execution-logs", executionId, item?.revision], (_services, context) => live.logs(context, executionId), !!item?.hasLogs);
  const run = why(resolved, "data.write");
  return (
    <QueryView query={query}>
      {item && (
        <>
          <h2>Execution</h2>
          <Link to={base}>Back to the function</Link>
          <p>{describe(item)}</p>
          <p>Created {when(item.createdAt)} · started {when(item.startedAt)} · finished {when(item.completedAt)}</p>
          {open && <p role="status">This execution has not finished. <button type="button" onClick={() => void query.refetch()}>Refresh</button></p>}
          {item.prunedAt
            ? <p>Its input, output and log were removed on {when(item.prunedAt)}, thirty days after it ended.</p>
            : <><h3>Output</h3>{item.state === "succeeded" ? <Inspect value={item.output} /> : <p>An execution has an output only when it succeeds.</p>}</>}
          <h3>Log</h3>
          {item.hasLogs
            ? <QueryView query={logs}>{logs.data ? <><pre>{logs.data.text}</pre>{logs.data.truncated && <p>The log was cut at its size limit.</p>}<p>Secret values of this function are replaced with [redacted] before a log is stored.</p></> : <p>No log.</p>}</QueryView>
            : <p>{open ? "The log arrives when the execution finishes." : item.prunedAt ? "Removed." : "It printed nothing."}</p>}
          {open && <CommandForm title="Cancel this execution" revision={item.revision} disabled={run} submit={(_values, options) => live.executionCommand({ scope }, executionId, "cancel", options)} />}
          {!open && item.state !== "succeeded" && <CommandForm title="Run it again" revision={item.revision} disabled={run} after={receipt => receipt.resourceId && navigate(`${base}/invocations/${receipt.resourceId}`)}
            submit={(_values, options) => live.executionCommand({ scope }, executionId, "retry", options)}><p>A retry runs the same revision with the same input, as a new execution.</p></CommandForm>}
        </>
      )}
    </QueryView>
  );
}

const rhythm = (item: LiveSchedule) => (item.cron ? `${item.cron} in ${item.timeZone}` : `every ${item.intervalSeconds} seconds`);
const SKIPPED: Record<NonNullable<LiveSchedule["lastSkipReason"]>, string> = {
  overlap: "the previous run had not finished", function_disabled: "the function was disabled", limit: "the environment was at its limit of open executions", unavailable: "something the function needs was missing",
};

function Schedules({ scope, resolved, functionId }: Props & { functionId: string }) {
  const live = useLive(); const base = `${scopePath(scope)}/functions/${functionId}`;
  const query = useDataQuery(scope, ["live-schedules", functionId], (_services, context) => live.schedules(context, functionId));
  const configure = why(resolved, "resources.configure");
  const parseInput = (text: string | undefined) => { if (!text?.trim()) return {}; return { input: JSON.parse(text) as unknown }; };
  const invalid = { ok: false as const, error: { code: "validation" as const, message: "The input is not valid JSON.", requestId: "" } };
  return (
    <>
      <h2>Schedules</h2>
      <Link to={base}>Back to the function</Link>
      <p>A slot is skipped, not saved up, when the previous run is still going or the function is disabled. After an outage a schedule runs once, however many slots were missed.</p>
      <QueryView query={query}>
        {query.data && !query.data.length && <p>No schedules.</p>}
        {query.data?.map(item => (
          <article key={item.id}>
            <h3>{rhythm(item)}</h3>
            <p>{item.state === "active" ? `Next run ${when(item.nextRunAt)}` : "Paused"} · last run {when(item.lastRunAt)}</p>
            {item.lastSkippedAt && item.lastSkipReason && <p>Last skipped {when(item.lastSkippedAt)}: {SKIPPED[item.lastSkipReason]}.</p>}
            {item.input !== null && <Inspect value={item.input} />}
            <CommandForm title={item.state === "active" ? "Pause" : "Resume"} revision={item.revision} disabled={configure} submit={(_values, options) => live.scheduleCommand({ scope }, item.id, item.state === "active" ? "pause" : "resume", options)} />
            <CommandForm title="Delete this schedule" revision={item.revision} disabled={configure} submit={(_values, options) => live.scheduleCommand({ scope }, item.id, "delete", options)} />
          </article>
        ))}
      </QueryView>
      <CommandForm title="Run on a calendar" disabled={configure}
        fields={[{ name: "cron", label: "When: minute hour day-of-month month day-of-week, numbers only. Example: 30 9 * * 1-5", maxLength: 100 }, { name: "zone", label: "Time zone, an IANA name. Example: Europe/Brussels", value: "UTC", maxLength: 64 },
          { name: "input", label: "Input for each run, as JSON (optional)", type: "textarea", required: false }]}
        submit={(values, options) => { try { return live.createSchedule({ scope }, functionId, { cron: values.cron!, timeZone: values.zone!, ...parseInput(values.input) }, options); } catch { return Promise.resolve(invalid); } }}>
        <p>A time that does not exist on a day, because the clocks went forward, does not run that day. A time that happens twice runs once.</p>
      </CommandForm>
      <CommandForm title="Run on an interval" disabled={configure}
        fields={[{ name: "seconds", label: "Seconds between runs, 60 to 604800", type: "number", value: "3600" }, { name: "input", label: "Input for each run, as JSON (optional)", type: "textarea", required: false }]}
        submit={(values, options) => { try { return live.createSchedule({ scope }, functionId, { intervalSeconds: Number(values.seconds), ...parseInput(values.input) }, options); } catch { return Promise.resolve(invalid); } }} />
    </>
  );
}
