import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { scopeKey } from "../../framework/queries/scope-cache";
import { scopePath } from "../../framework/routing/routes";
import { useServices } from "../../framework/services/context";
import {
  unwrap,
  type PageRequest,
  type Scope,
} from "../../framework/services/contracts";
import { useSession } from "../../framework/session/SessionProvider";
export function CatalogPage({ scope }: { scope?: Scope }) {
  const services = useServices();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const request: PageRequest = {
    cursor: params.get("cursor") ?? undefined,
    limit: 2,
    sort: params.get("sort") === "id" ? "id" : "name",
    filter: { name: params.get("q") ?? "" },
  };
  const query = useQuery({
    queryKey: [...scopeKey(session!.visibilityKey, scope), "catalog", request],
    queryFn: async ({ signal }) => {
      if (!scope) {
        const page = unwrap(
          await services.catalog.listOrganizations(request, { signal }),
        );
        return {
          ...page,
          items: page.items.map((org) => ({
            ...org,
            href: scopePath({ orgId: org.id }) + "/overview",
          })),
        };
      }
      if (!scope.projectId) {
        const page = unwrap(
          await services.catalog.listProjects({ scope, signal }, request),
        );
        return {
          ...page,
          items: page.items.map((project) => ({
            ...project,
            href:
              scopePath({ orgId: scope.orgId, projectId: project.id }) +
              "/overview",
          })),
        };
      }
      const page = unwrap(
        await services.catalog.listEnvironments({ scope, signal }, request),
      );
      return {
        ...page,
        items: page.items.map((env) => ({
          ...env,
          href: scopePath({ ...scope, environmentId: env.id }) + "/overview",
        })),
      };
    },
  });
  const title = !scope
    ? "Organizations"
    : !scope.projectId
      ? "Projects"
      : "Environments";
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    next.set(key, value);
    next.delete("cursor");
    setParams(next, { replace: true });
  }
  return (
    <section>
      <h2>{title}</h2>
      <div className="controls">
        <label>
          Filter by name{" "}
          <input
            value={request.filter?.name}
            onChange={(e) => filter("q", e.target.value)}
          />
        </label>
        <label>
          Sort{" "}
          <select
            value={request.sort}
            onChange={(e) => filter("sort", e.target.value)}
          >
            <option value="name">Name</option>
            <option value="id">ID</option>
          </select>
        </label>
      </div>
      {query.isPending ? (
        <p role="status">Loading {title.toLowerCase()}…</p>
      ) : query.error ? (
        <Feedback
          error={query.error}
          retry={() => {
            const next = new URLSearchParams(params);
            next.delete("cursor");
            setParams(next);
            void query.refetch();
          }}
        />
      ) : (
        <>
          {query.data.items.length === 0 ? (
            <p>
              {request.filter?.name
                ? "No matching results. Clear the filter to see available resources."
                : "No resources yet. Use the creation form below to get started."}
            </p>
          ) : (
            <ul className="resource-list">
              {query.data.items.map((item) => (
                <li key={item.id}>
                  <Link to={item.href}>{item.name}</Link>
                  <code>{item.id}</code>
                  <small>Revision {item.revision}</small>
                </li>
              ))}
            </ul>
          )}
          <p>{query.data.total} results · 2 per page</p>
          <div className="controls">
            <button
              disabled={!request.cursor}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete("cursor");
                setParams(next);
              }}
            >
              First page
            </button>
            <button
              disabled={!query.data.nextCursor}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("cursor", query.data.nextCursor!);
                setParams(next);
              }}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}
