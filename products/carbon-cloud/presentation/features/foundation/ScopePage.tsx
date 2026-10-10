import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { OperationPanel } from "../../framework/operations/OperationPanel";
import { scopeKey } from "../../framework/queries/scope-cache";
import { scopePath } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import { unwrap, type Scope } from "../../framework/services/contracts";
import { useSession } from "../../framework/session/SessionProvider";
import { CatalogPage } from "./CatalogPage";
import { CreateResource, EnvironmentControls, PlatformPage, ScopeNavigation } from "../identity/PlatformPages";
import { ConfigurationScopePage, ProjectChecklist } from "../configuration/ConfigurationPages";
import { DeliveryScopePage } from "../delivery/DeliveryPages";
import { DataScopePage } from "../data/DataPages";
import { ExtensionPages } from "../extensions/ExtensionPages";
import { FunctionPages } from "../functions/FunctionPages";
import { RegistryScopePage } from "../registry/RegistryPages";
import { BillingScopePage } from "../operations/BillingPages";
export function ScopePage({
  scope,
  label,
  slice,
  operationId,
}: {
  scope: Scope;
  label: string;
  slice: number;
  operationId?: string;
}) {
  const services = useServices();
  const [params] = useSearchParams();
  const { session } = useSession();
  const key = scopeKey(session!.visibilityKey, scope);
  const query = useQuery({
    queryKey: [...key, "scope"],
    queryFn: async ({ signal }) =>
      unwrap(await services.catalog.resolveScope({ scope, signal })),
  });
  const capability = useQuery({
    queryKey: [...key, "capabilities"],
    queryFn: async ({ signal }) =>
      unwrap(
        await services.capabilities.getAvailableCapabilities({ scope, signal }),
      ),
    enabled: query.isSuccess,
  });
  if (query.isPending) return <p role="status">Resolving authorized scope…</p>;
  if (query.error)
    return <Feedback error={query.error} retry={() => void query.refetch()} />;
  const resolved = query.data;
  return (
    <>
      <nav aria-label="Scope breadcrumbs">
        <Link to="/organizations">Organizations</Link> /{" "}
        <Link to={`${scopePath({ orgId: scope.orgId })}/overview`}>
          {resolved.organization.name}
        </Link>
        {resolved.project && (
          <>
            {" "}
            /{" "}
            <Link
              to={`${scopePath({ orgId: scope.orgId, projectId: resolved.project.id })}/overview`}
            >
              {resolved.project.name}
            </Link>
          </>
        )}
        {resolved.environment && (
          <>
            {" "}
            /{" "}
            <Link to={`${scopePath(scope)}/overview`}>
              {resolved.environment.name}
            </Link>
          </>
        )}
      </nav>
      <h1>{label}</h1>
      <ScopeNavigation scope={scope} resolved={resolved} />
      {!scope.projectId && <nav aria-label="Billing navigation"><Link to={`${scopePath(scope)}/billing`}>Billing</Link><Link to={`${scopePath(scope)}/usage`}>Usage</Link></nav>}
      {scope.environmentId && <nav aria-label="Limits navigation"><Link to={`${scopePath(scope)}/settings/limits`}>Limits</Link></nav>}
      {!scope.projectId && <nav aria-label="Registry publishing navigation"><Link to={`${scopePath(scope)}/publishing`}>Publisher packages</Link></nav>}
      {scope.projectId && !scope.environmentId && <nav aria-label="Project plugin navigation"><Link to={`${scopePath(scope)}/plugins`}>Project plugins</Link></nav>}
      <p>
        <code>
          {scope.orgId}
          {scope.projectId && ` / ${scope.projectId}`}
          {scope.environmentId && ` / ${scope.environmentId}`}
        </code>
      </p>
      {resolved.environment?.kind === "production" && (
        <p className="notice">
          Production environment selected. Environment and update channel are
          separate scopes.
        </p>
      )}
      {slice === 9 ? <BillingScopePage scope={scope} resolved={resolved} /> : slice === 8 ? <RegistryScopePage scope={scope} resolved={resolved} /> : slice === 7 ? <FunctionPages scope={scope} resolved={resolved} /> : slice === 6 ? <ExtensionPages scope={scope} resolved={resolved} /> : slice === 5 ? <DataScopePage scope={scope} resolved={resolved} /> : slice === 4 ? <DeliveryScopePage scope={scope} resolved={resolved} /> : slice === 3 ? <ConfigurationScopePage scope={scope} resolved={resolved} /> : slice === 2 ? <PlatformPage scope={scope} resolved={resolved} /> : slice > 4 ? (
        <section>
          <h2>Capability unavailable</h2>
          <p>
            This workflow is scheduled for Slice {slice}. Its service adapter
            has not been implemented.
          </p>
        </section>
      ) : !resolved.permissions["metadata.read"].allowed ? (
        <section>
          <h2>Billing access</h2>
          <p>{resolved.permissions["metadata.read"].reason}</p>
          <Link to={`${scopePath(scope)}/billing`}>Billing (Slice 9)</Link>
        </section>
      ) : (
        <>
          {!scope.environmentId && <>{scope.projectId && <ProjectChecklist scope={scope} />}<CatalogPage scope={scope} /><CreateResource scope={scope} resolved={resolved} />{resolved.permissions["audit.read"].allowed && <AuditPanel scope={scope} />}</>}
          {scope.environmentId && (
            <>
              <section>
                <h2>Canonical service bindings</h2>
                <table>
                  <thead>
                    <tr>
                      <th>Owner</th>
                      <th>State</th>
                      <th>Fixture resource</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolved.bindings.map((binding) => (
                      <tr key={binding.id}>
                        <td>{binding.owner}</td>
                        <td>{binding.state}</td>
                        <td>
                          <code>{binding.serviceResourceId}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <OperationPanel scope={scope} operationId={operationId ?? params.get("operation") ?? undefined} />
              <EnvironmentControls scope={scope} resolved={resolved} />
              <section><h2>Integration settings</h2><nav><Link to={`${scopePath(scope)}/settings/api`}>API and credentials</Link><Link to={`${scopePath(scope)}/settings/secrets`}>Secrets</Link></nav></section>
              {resolved.permissions["audit.read"].allowed && (
                <AuditPanel scope={scope} />
              )}
            </>
          )}
        </>
      )}
      <details>
        <summary>Effective permissions</summary>
        <ul>
          {Object.entries(resolved.permissions).map(([permission, action]) => (
            <li key={permission}>
              <code>{permission}</code>:{" "}
              {action.allowed ? "allowed" : action.reason}
            </li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Capability catalog</summary>
        {capability.isPending ? (
          <p>Loading capabilities…</p>
        ) : capability.error ? (
          <Feedback
            error={capability.error}
            retry={() => void capability.refetch()}
          />
        ) : (
          <ul>
            {capability.data.map((entry) => (
              <li key={entry.id}>
                {entry.id}:{" "}
                {entry.available ? "available in mock mode" : entry.reason}
                {entry.limits && (
                  <pre>{JSON.stringify(entry.limits, null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </>
  );
}
function AuditPanel({ scope }: { scope: Scope }) {
  const services = useServices();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const cursor = params.get("auditCursor") ?? undefined;
  const query = useQuery({
    queryKey: [...scopeKey(session!.visibilityKey, scope), "audit", cursor],
    queryFn: async ({ signal }) =>
      unwrap(
        await services.activity.listAudit(
          { scope, signal },
          { limit: 5, cursor },
        ),
      ),
  });
  return (
    <section>
      <h2>Safe audit metadata</h2>
      {query.isPending ? (
        <p>Loading activity…</p>
      ) : query.error ? (
        <Feedback error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          <ul>
            {query.data.items.map((entry) => (
              <li key={entry.id}>
                {entry.occurredAt} · {entry.actorId} · {entry.action} ·{" "}
                {entry.outcome}
              </li>
            ))}
          </ul>
          {!query.data.items.length && <p>No audit records in this scope.</p>}
          <div className="controls">
            <button
              disabled={!cursor}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete("auditCursor");
                setParams(next);
              }}
            >
              First audit page
            </button>
            <button
              disabled={!query.data.nextCursor}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("auditCursor", query.data.nextCursor!);
                setParams(next);
              }}
            >
              More audit records
            </button>
          </div>
        </>
      )}
    </section>
  );
}
