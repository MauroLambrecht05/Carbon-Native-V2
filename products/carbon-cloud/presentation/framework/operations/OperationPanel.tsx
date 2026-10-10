import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { scopeKey } from "../queries/scope-cache";
import { scopePath } from "../routing/routes";
import { useServices } from "../services/context";
import { unwrap, type Scope } from "../services/contracts";
import { useSession } from "../session/SessionProvider";
export function OperationPanel({
  scope,
  operationId,
}: {
  scope: Scope;
  operationId?: string;
}) {
  const services = useServices();
  const { session } = useSession();
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [commandKey, setCommandKey] = useState(() => crypto.randomUUID());
  const key = scopeKey(session!.visibilityKey, scope);
  const cursor = params.get("operationsCursor") ?? undefined;
  const query = useQuery({
    queryKey: [...key, "operations", operationId, cursor],
    queryFn: async ({ signal }) =>
      operationId
        ? {
            items: [
              unwrap(
                await services.operations.get({ scope, signal }, operationId),
              ),
            ],
            nextCursor: null,
          }
        : unwrap(
            await services.operations.list(
              { scope, signal },
              { limit: 5, cursor },
            ),
          ),
  });
  const mutation = useMutation({
    mutationFn: async ({
      id,
      revision,
      retry,
    }: {
      id: string;
      revision: string;
      retry: boolean;
    }) =>
      unwrap(
        await services.operations[retry ? "retryAllowedStep" : "requestCancel"](
          { scope },
          id,
          { idempotencyKey: commandKey, expectedRevision: revision },
        ),
      ),
    onSuccess: () => {
      setCommandKey(crypto.randomUUID());
      void cache.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <section>
      <h2>Mock operations</h2>
      <p>
        Local operation progress is retained across navigation and reload.
        Use each resource's workflow for build cancellation or release retries.
      </p>
      {query.isPending ? (
        <p role="status">Loading operations…</p>
      ) : query.error ? (
        <Feedback error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {!query.data.items.length && (
            <p>
              No operations. Use “Run fixture check” in mock tools to exercise
              the scheduler.
            </p>
          )}
          {query.data.items.map((operation) => (
            <article key={operation.id}>
              <h3>
                {operation.kind === "windows.build" || operation.kind === "release.publish" ? operation.id : <Link
                  to={`${scopePath(operation.scope)}/foundation/operations/${operation.id}`}
                >
                  {operation.id}
                </Link>}
              </h3>
              <p>
                {operation.state} · {operation.revision} ·{" "}
                {operation.completedSteps}/{operation.totalSteps} steps
              </p>
              <progress
                value={operation.completedSteps}
                max={operation.totalSteps}
                aria-label="Completed operation steps"
              />
              <ol>
                {operation.steps.map((step, index) => (
                  <li key={step}>
                    {step}:{" "}
                    {index < operation.completedSteps ? "complete" : "pending"}
                  </li>
                ))}
              </ol>
              {operation.error && <p role="alert">{operation.error.message}</p>}
              <div className="controls">
                <button
                  disabled={
                    mutation.isPending || !operation.actions.cancel.allowed
                  }
                  title={operation.actions.cancel.reason}
                  onClick={() =>
                    mutation.mutate({
                      id: operation.id,
                      revision: operation.revision,
                      retry: false,
                    })
                  }
                >
                  Request cancellation
                </button>
                <button
                  disabled={
                    mutation.isPending || !operation.actions.retry.allowed
                  }
                  title={operation.actions.retry.reason}
                  onClick={() =>
                    mutation.mutate({
                      id: operation.id,
                      revision: operation.revision,
                      retry: true,
                    })
                  }
                >
                  Retry failed step
                </button>
              </div>
              <p className="muted">
                Created {operation.createdAt} · Correlation{" "}
                {operation.requestId}
              </p>
            </article>
          ))}
          {!operationId && (
            <div className="controls">
              <button
                disabled={!cursor}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("operationsCursor");
                  setParams(next);
                }}
              >
                First operations
              </button>
              <button
                disabled={!query.data.nextCursor}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("operationsCursor", query.data.nextCursor!);
                  setParams(next);
                }}
              >
                More operations
              </button>
            </div>
          )}
        </>
      )}
      {mutation.isPending && <p role="status">Saving command…</p>}
      {mutation.error && (
        <Feedback
          error={mutation.error}
          retry={() => {
            mutation.reset();
            setCommandKey(crypto.randomUUID());
            void query.refetch();
          }}
        />
      )}
    </section>
  );
}
