import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import {
  resolveRoute,
  safeReturn,
  scopePath,
} from "../../framework/routing/routes";
import { useSession } from "../../framework/session/SessionProvider";
import { unwrap, type ErrorCode } from "../../framework/services/contracts";
import { scopeKey } from "../../framework/queries/scope-cache";
import type { MockTools } from "./contracts";
export function MockToolsPanel({ tools }: { tools: MockTools }) {
  const location = useLocation();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const { session } = useSession();
  const scope = resolveRoute(location.pathname)?.scope;
  const [status, setStatus] = useState<Awaited<
    ReturnType<MockTools["inspect"]>
  > | null>(null);
  const [inbox, setInbox] = useState<Awaited<ReturnType<MockTools["inbox"]>> | null>(null);
  const [inboxFilter, setInboxFilter] = useState("");
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [outcome, setOutcome] = useState<"success" | "partial_failure">(
    "success",
  );
  const [idempotencyKey, setIdempotencyKey] = useState("fixture-check-1");
  const [failureTarget, setFailureTarget] = useState<
    "catalog.resolve" | "foundation.start"
  >("catalog.resolve");
  const [failureCode, setFailureCode] = useState<ErrorCode>("unavailable");
  const [latency, setLatency] = useState("120");
  const [sourceVersion, setSourceVersion] = useState("1.1.0");
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void tools.inbox().then(result => { if (alive) setInbox(result); });
      void tools.inspect().then((result) => {
        if (alive) setStatus(result);
      });
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [tools]);
  async function perform(action: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await action();
      setStatus(await tools.inspect());
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  const data = status?.ok ? status.value : null;
  return (
    <aside className="mock-tools">
      <h2>Mock tools · local fixtures only</h2>
      <p>
        No credentials, provider requests, service calls, or native execution.
        Fixture identities are not a sign-in implementation.
      </p>
      <fieldset disabled={pending}>
        <details>
          <summary>Windows build and release scenarios</summary>
          <label>Delivery outcome (applies to newly submitted work; reset to success for retries)<select value={data?.deliveryScenario ?? "success"} onChange={e => void perform(async () => { unwrap(await tools.deliveryScenario(e.target.value as Parameters<MockTools["deliveryScenario"]>[0])); })}>{["success", "build_failure", "lease_expiry", "lease_exhaustion", "timeout", "publish_failure", "quota", "no_capacity", "plugin_revoked", "plugin_incompatible", "signing_invalid", "signing_unknown", "signing_expired", "stale_ref", "lost_response"].map(value => <option key={value}>{value}</option>)}</select></label>
          <label>Simulated next repository manifest version<input value={sourceVersion} onChange={e => setSourceVersion(e.target.value)} /></label>
          <button disabled={!scope?.projectId} onClick={() => void perform(async () => { if (scope) unwrap(await tools.advanceDeliverySource({ orgId: scope.orgId, projectId: scope.projectId }, sourceVersion)); })}>Simulate source commit with new version</button>
          <p>This changes local source fixture metadata for a future build. Historical inputs and releases are unchanged. No repository or runtime is contacted.</p>
          <p>Simulated delivery observations for this project's channels:</p>
          {(["not_reported", "simulated", "offline", "stale"] as const).map(value => <button key={value} disabled={!scope?.projectId} onClick={() => void perform(async () => { if (scope) unwrap(await tools.setDeliveryEvidence({ orgId: scope.orgId, projectId: scope.projectId }, value)); })}>{value}</button>)}
        </details>
        <details open>
          <summary>Development mock inbox and authenticator</summary>
          <p>One-use simulated challenges are visible only through this development port. No email or GitHub request is sent. Fixture emails use account-id@example.test.</p>
          <label>Filter inbox email<input value={inboxFilter} onChange={e => setInboxFilter(e.target.value)} /></label>
          {inbox?.ok ? <>
            <ul>{inbox.value.messages.filter(m => m.email.includes(inboxFilter)).slice(-20).reverse().map(m => <li key={m.id}>{m.email} · {m.purpose} · {m.status} · expires {m.expiresAt} · <Link to={m.href}>Open {m.purpose} challenge</Link></li>)}</ul>
            {!inbox.value.messages.length && <p>No simulated messages yet. Request a sign-in or invitation above.</p>}
            <p>Showing the latest 20 matching messages.</p>
            <ul>{inbox.value.authenticators.map(a => <li key={a.accountId}>Mock authenticator for {a.email}: <code>{a.code}</code></li>)}</ul>
            <button onClick={() => void perform(async () => { unwrap(await tools.failNextProvision()); setInbox(await tools.inbox()); })}>Fail next provisioning after its first stage</button>
            <p>Provisioning failure: {inbox.value.provisionFailure ? "armed" : "not armed"}</p>
          </> : inbox && <Feedback error={inbox.error.message} />}
        </details>
        <div className="controls">
          <label>
            Fixture identity{" "}
            <select
              value={session?.accountId ?? ""}
              onChange={(e) =>
                void perform(async () => {
                  unwrap(await tools.selectIdentity(e.target.value || null));
                  if (location.pathname === "/sign-in")
                    navigate(
                      safeReturn(
                        new URLSearchParams(location.search).get("returnTo"),
                      ),
                    );
                })
              }
            >
              <option value="">Fresh visitor</option>
              {data?.identities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {identity.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() =>
              void perform(async () => {
                unwrap(
                  await tools.selectIdentity(session?.accountId ?? "owner"),
                );
              })
            }
          >
            Renew fixture session
          </button>
        </div>
        {data && (
          <>
            <p>
              <time>{data.now}</time> · Clock{" "}
              {data.paused ? "paused" : "running"}
            </p>
            <div className="controls">
              <button
                onClick={() =>
                  void perform(async () => {
                    unwrap(await tools.setClock(!data.paused));
                  })
                }
              >
                {data.paused ? "Resume clock" : "Pause clock"}
              </button>
              <button
                onClick={() =>
                  void perform(async () => {
                    unwrap(await tools.setClock(data.paused, 10_000));
                  })
                }
              >
                Advance 10 seconds
              </button>
              <button
                onClick={() =>
                  void perform(async () => {
                    unwrap(await tools.setClock(data.paused, 3_600_000));
                  })
                }
              >
                Advance 1 hour (expire session)
              </button>
            </div>
          </>
        )}
        <details>
          <summary>Failure and concurrency controls</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                unwrap(await tools.setLatency(Number(latency)));
              });
            }}
          >
            <label>
              Request latency (ms){" "}
              <input
                type="number"
                min="0"
                max="10000"
                required
                value={latency}
                onChange={(e) => setLatency(e.target.value)}
              />
            </label>
            <button>Set latency</button>
            <small>Current: {data?.latencyMs ?? "unknown"} ms</small>
          </form>
          <div className="controls">
            <label>
              Next operation{" "}
              <select
                value={failureTarget}
                onChange={(e) =>
                  setFailureTarget(e.target.value as typeof failureTarget)
                }
              >
                <option value="catalog.resolve">Scope query</option>
                <option value="foundation.start">Start fixture check</option>
              </select>
            </label>
            <label>
              Failure{" "}
              <select
                value={failureCode}
                onChange={(e) => setFailureCode(e.target.value as ErrorCode)}
              >
                {[
                  "unavailable",
                  "validation",
                  "forbidden",
                  "unauthenticated",
                  "not_found",
                  "rate_limited",
                  "quota_exceeded",
                  "conflict",
                  "unsupported_operation",
                  "cancelled",
                ].map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() =>
                void perform(async () => {
                  unwrap(await tools.injectFailure(failureTarget, failureCode));
                })
              }
            >
              Arm one-shot failure
            </button>
            <button
              onClick={() =>
                void perform(async () => {
                  unwrap(await tools.injectFailure(failureTarget, null));
                })
              }
            >
              Clear failure
            </button>
            <button
              onClick={() =>
                void cache.invalidateQueries({
                  queryKey: scopeKey(
                    session?.visibilityKey ?? "visitor",
                    scope,
                  ),
                })
              }
            >
              Refetch visible context
            </button>
          </div>
          <p>Armed: {data?.failure ?? "none"}</p>
          <button
            onClick={() =>
              void perform(async () => {
                unwrap(
                  await tools.injectFailure(
                    "foundation.start",
                    "unavailable",
                    "after",
                  ),
                );
              })
            }
          >
            Lose next command response after commit
          </button>
          {scope && (
            <button
              onClick={() =>
                void perform(async () => {
                  unwrap(await tools.revokeMembership(scope));
                })
              }
            >
              Revoke current fixture membership
            </button>
          )}
        </details>
        {scope?.environmentId && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                const result = unwrap(
                  await tools.startCheck(scope, outcome, { idempotencyKey }),
                );
                navigate(
                  `${scopePath(scope)}/foundation/operations/${result.id}`,
                );
              });
            }}
          >
            <h3>Exercise operation contracts</h3>
            <label>
              Outcome{" "}
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as typeof outcome)}
              >
                <option value="success">Success</option>
                <option value="partial_failure">
                  Fail Database check after Cloud completes
                </option>
              </select>
            </label>
            <label>
              Idempotency key{" "}
              <input
                required
                maxLength={200}
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
              />
            </label>
            <button>Run fixture check</button>
            <p>
              Reuse this key to recover the original operation. A changed
              outcome with the same key returns a conflict.
            </p>
          </form>
        )}
        <details>
          <summary>Reset fake workspace</summary>
          <p>
            Replaces all fixture records, sessions, operation history, clock and
            controls in every tab. This fake history cannot be recovered.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                unwrap(await tools.reset(confirmation));
                setConfirmation("");
                navigate("/sign-in");
              });
            }}
          >
            <label>
              Type RESET MOCK{" "}
              <input
                required
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <button>Reset workspace</button>
          </form>
        </details>
      </fieldset>
      {pending && <p role="status">Applying mock control…</p>}
      {error !== undefined && <Feedback error={error} />}
      {status && !status.ok && <Feedback error={status.error.message} />}
    </aside>
  );
}
