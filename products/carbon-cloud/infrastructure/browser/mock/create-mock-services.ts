import type {
  Audit,
  BrowserServices,
  Change,
  Capability,
  CommandOptions,
  Operation,
  PlatformEvent,
  RequestContext,
  Result,
  Scope,
  ServiceError,
  SubscriptionMessage,
} from "../../../presentation/framework/services/contracts";
import type { MockTools } from "../../../presentation/devtools/mock-scenarios/contracts";
import {
  containsScope,
  currentSession,
  Refusal,
  requirePermission,
  requireSession,
  resolveScope,
} from "./access";
import { now, setClock } from "./clock";
import { paginate } from "./pagination";
import {
  fixtureSession,
  identities,
  seedFoundation,
} from "./scenarios/foundation";
import type { MockState, Persistence } from "./store";
import { identityState, reconcileIdentity } from "./identity-state";
import { accountAudit, createIdentityServices, mfaCode } from "./identity-services";
import { createPlatformServices, reconcileProvisioning } from "./platform-services";
import { createConfigurationServices } from "./configuration-services";
import { reconcileConfiguration } from "./configuration-state";
import { createDeliveryServices } from "./delivery-services";
import { reconcileDelivery, deliveryEvent } from "./delivery-engine";
import { deliveryState, digest } from "./delivery-state";
import { createDataServices } from "./data-services";
import { createAppAuthServices } from "./app-auth-services";
import { reconcileData } from "./data-engine";
import { createExtensionServices } from "./extension-services";
import { reconcileExtensions } from "./extension-recovery";
import { reconcileFunctions } from "./function-engine";
import { createFunctionServices } from "./function-services";
import { captureRows } from "./extension-state";
import { createRegistryServices } from "./registry-services";
import { createBillingServices, createOperatorServices } from "./operations-services";

export interface MockRuntime {
  services: BrowserServices;
  tools: MockTools;
  tick(): Promise<void>;
  dispose(): void;
}
export interface RuntimeOptions {
  persistence: Persistence;
  wallTime?: () => number;
  channel?: BroadcastChannel;
  autoTick?: boolean;
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const error = (cause: unknown, requestId: string): ServiceError => ({
  code: cause instanceof Refusal ? cause.code : "unavailable",
  message:
    cause instanceof Error
      ? cause.message
      : "Mock persistence unavailable; the change was not confirmed.",
  requestId,
});
function id(state: MockState, prefix: string): string {
  return `${prefix}_${String(state.nextId++).padStart(8, "0")}`;
}
const iso = (time: number) => new Date(time).toISOString();
const nextRevision = (revision: string) => `r${Number(revision.slice(1)) + 1}`;
function scopeKey(scope: Scope) {
  return JSON.stringify([
    scope.orgId,
    scope.projectId ?? null,
    scope.environmentId ?? null,
  ]);
}
function publish(
  state: MockState,
  record: Operation,
  action: string,
  time: number,
): void {
  const event: PlatformEvent = {
    id: `event_${++state.sequence}`,
    cursor: String(state.sequence),
    scope: record.scope,
    resourceId: record.id,
    revision: record.revision,
    action,
    actorId: record.actorId,
    occurredAt: iso(time),
  };
  state.events[event.id] = event;
  const audit: Audit = {
    id: id(state, "audit"),
    scope: record.scope,
    actorId: record.actorId,
    action,
    resourceId: record.id,
    outcome: record.state === "failed" ? "failed" : "succeeded",
    occurredAt: iso(time),
    requestId: record.requestId,
  };
  state.audits[audit.id] = audit;
}
function actions(record: Operation, writable: boolean): Operation {
  const terminal = ["succeeded", "failed", "cancelled"].includes(record.state);
  return {
    ...record,
    actions: {
      cancel: {
        allowed: writable && !terminal,
        reason: terminal
          ? "Operation is already terminal."
          : writable
            ? undefined
            : "Resource configuration permission required.",
      },
      retry: {
        allowed: writable && record.state === "failed",
        reason:
          record.state === "failed"
            ? writable
              ? undefined
              : "Resource configuration permission required."
            : "Only a failed step can be retried.",
      },
    },
  };
}
function reconcile(state: MockState, wall: number): boolean {
  let changed = reconcileIdentity(state, wall);
  changed = reconcileConfiguration(state, wall) || changed;
  changed = reconcileDelivery(state, wall) || changed;
  changed = reconcileData(state, wall) || changed;
  changed = reconcileExtensions(state, wall) || changed;
  changed = reconcileFunctions(state, wall) || changed;
  const time = now(state.clock, wall);
  const session = state.activeSessionId
    ? state.sessions[state.activeSessionId]
    : undefined;
  if (session && !session.revoked && Date.parse(session.expiresAt) <= time) {
    session.revoked = true;
    state.accessRevision++;
    changed = true;
  }
  for (const stored of Object.values(state.operations)) {
    if (stored.record.kind === "windows.build" || stored.record.kind === "release.publish" || stored.record.kind.startsWith("data.") || stored.record.kind === "function.deploy") continue;
    while (
      stored.deadline <= time &&
      ["queued", "running", "cancel_requested"].includes(stored.record.state)
    ) {
      const record = stored.record;
      let status: Operation["state"] = record.state;
      let completedSteps = record.completedSteps;
      let failure: ServiceError | undefined;
      if (status === "cancel_requested") status = "cancelled";
      else if (status === "queued") status = "running";
      else if (stored.failStep === completedSteps) {
        status = "failed";
        failure = {
          code: "unavailable",
          message: `Simulated failure at ${record.steps[completedSteps]}. Completed checks are retained.`,
          requestId: record.requestId,
        };
      } else {
        completedSteps++;
        if (completedSteps === record.totalSteps) status = "succeeded";
      }
      stored.record = {
        ...record,
        state: status,
        completedSteps,
        revision: nextRevision(record.revision),
        updatedAt: iso(stored.deadline),
        error: failure,
      };
      reconcileProvisioning(state, stored.record);
      publish(state, stored.record, `operation.${status}`, stored.deadline);
      stored.deadline += 1000;
      changed = true;
    }
  }
  return changed;
}
async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Refusal("cancelled", "Request cancelled.");
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(new Refusal("cancelled", "Request cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

export function createMockServices(options: RuntimeOptions): MockRuntime {
  const { persistence, channel } = options;
  const wallTime = options.wallTime ?? Date.now;
  const listeners = new Set<(change: Change) => void>();
  let disposed = false;
  let lastRevision = -1;
  let lastAccess = -1;
  const runtimeId = crypto.randomUUID();
  let requestSequence = 0;
  const notify = (change: Change) => {
    for (const listener of listeners) listener(change);
  };
  // Broadcasts contain invalidation metadata only. Receivers reread authoritative IDB.
  if (channel)
    channel.onmessage = () => {
      void tick();
    };
  async function run<T>(
    execute: (state: MockState, requestId: string) => T,
    config: {
      signal?: AbortSignal;
      mutate?: boolean;
      target?: "catalog.resolve" | "foundation.start";
      fast?: boolean;
      quiet?: boolean;
      audit?: { scope: Scope; action: string; resourceId?: string };
    } = {},
  ): Promise<Result<T>> {
    const requestId = `mock:${runtimeId}:${++requestSequence}`;
    try {
      const start = await persistence.transact((state) => ({
        value: {
          latency: state.latencyMs,
          sessionId: state.activeSessionId,
          access: state.accessRevision,
        },
        changed: false,
      }));
      if (!config.fast) await delay(start.latency, config.signal);
      if (disposed || config.signal?.aborted)
        throw new Refusal("cancelled", "Request cancelled.");
      const transaction = await persistence.transact((state) => {
        const beforeRows = structuredClone(state.data?.rows ?? {});
        const beforeAccess = state.accessRevision;
        const beforeSequence = state.sequence;
        let changed = reconcile(state, wallTime());
        let result: Result<T>;
        try {
          if (config.signal?.aborted)
            throw new Refusal("cancelled", "Request cancelled.");
          if (
            !config.fast &&
            (start.sessionId !== state.activeSessionId ||
              start.access !== state.accessRevision)
          )
            throw new Refusal(
              "unauthenticated",
              "Visibility changed while the request was pending. Reload the authorized context.",
            );
          const injected =
            config.target && state.failure?.target === config.target
              ? state.failure
              : null;
          if (injected) {
            state.failure = null;
            changed = true;
          }
          if (injected?.phase === "before")
            result = { ok: false, error: { ...injected.error, requestId } };
          else {
            // Commands execute on a separate draft. A refusal cannot partially commit.
            const draft = config.mutate ? structuredClone(state) : state;
            result = ok(execute(draft, requestId));
            if (config.mutate) {
              const session = currentSession(draft, wallTime());
              if (session && draft.identity?.sessionDetails[session.id])
                draft.identity.sessionDetails[session.id].lastActivityAt = iso(now(draft.clock, wallTime()));
              Object.assign(state, draft);
              changed = true;
            }
            if (injected?.phase === "after")
              result = {
                ok: false,
                error: {
                  ...injected.error,
                  requestId,
                  message:
                    "The mock command committed but its response was lost. Recover using the same idempotency key; do not assume it failed.",
                },
              };
          }
        } catch (cause) {
          result = { ok: false, error: error(cause, requestId) };
        }
        if (!result.ok && config.audit) {
          try {
            // Known-scope refusals are audited without recording command payloads.
            resolveScope(state, config.audit.scope, wallTime());
            const auditId = id(state, "audit");
            state.audits[auditId] = {
              id: auditId,
              scope: config.audit.scope,
              actorId: requireSession(state, wallTime()).accountId,
              action: config.audit.action,
              resourceId: config.audit.resourceId ?? "foundation",
              outcome: "failed",
              occurredAt: iso(now(state.clock, wallTime())),
              requestId,
            };
            const cursor = String(++state.sequence);
            state.events[`event_${cursor}`] = {
              id: `event_${cursor}`,
              cursor,
              scope: config.audit.scope,
              actorId: state.audits[auditId].actorId,
              action: "audit.recorded",
              resourceId: auditId,
              revision: "r1",
              occurredAt: state.audits[auditId].occurredAt,
            };
            changed = true;
          } catch {
            /* Foreign scope existence is not disclosed or attributed. */
          }
        }
        if (changed) { captureRows(state, beforeRows, wallTime()); state.revision++; }
        const scopes = Object.values(state.events)
          .filter((event) => Number(event.cursor) > beforeSequence)
          .map((event) => event.scope);
        return {
          value: {
            result,
            changed,
            revision: state.revision,
            access: state.accessRevision,
            security: beforeAccess !== state.accessRevision,
            scopes,
          },
          changed,
        };
      });
      const external =
        lastRevision !== -1 && transaction.revision !== lastRevision;
      const security =
        transaction.security ||
        (lastAccess !== -1 && transaction.access !== lastAccess);
      lastRevision = transaction.revision;
      lastAccess = transaction.access;
      if ((transaction.changed || external) && (!config.quiet || security || transaction.scopes.length))
        notify({ security, scopes: transaction.scopes });
      if (transaction.changed && (!config.quiet || security || transaction.scopes.length))
        channel?.postMessage({ revision: transaction.revision });
      return transaction.result;
    } catch (cause) {
      return { ok: false, error: error(cause, requestId) };
    }
  }
  async function tick() {
    const result = await run(() => undefined, { fast: true });
    if (!result.ok) notify({ security: true, scopes: [] });
  }
  const visibility = (state: MockState, scope?: Scope) =>
    `${requireSession(state, wallTime()).visibilityKey}:${scope ? scopeKey(scope) : "account"}`;
  function readOperation(
    state: MockState,
    context: RequestContext,
    operationId: string,
  ): Operation {
    const resolved = requirePermission(
      state,
      context.scope,
      "metadata.read",
      wallTime(),
    );
    const stored = Object.hasOwn(state.operations, operationId)
      ? state.operations[operationId]
      : undefined;
    if (!stored || !containsScope(context.scope, stored.record.scope))
      throw new Refusal("not_found", "Operation not found.");
    const resource = requirePermission(
      state,
      stored.record.scope,
      "metadata.read",
      wallTime(),
    );
    if (stored.record.kind === "windows.build" || stored.record.kind === "release.publish" || stored.record.kind.startsWith("data.") || stored.record.kind === "function.deploy") return stored.record;
    return actions(
      stored.record,
      resource.permissions["resources.configure"].allowed &&
        resolved.permissions["metadata.read"].allowed,
    );
  }
  function command<T>(
    state: MockState,
    scope: Scope,
    commandName: string,
    payload: unknown,
    commandOptions: CommandOptions,
    execute: () => T,
  ): T {
    requirePermission(state, scope, "resources.configure", wallTime());
    if (
      !commandOptions.idempotencyKey?.trim() ||
      commandOptions.idempotencyKey.length > 200
    )
      throw new Refusal(
        "validation",
        "An idempotency key of 1–200 characters is required.",
      );
    const key = JSON.stringify([
      requireSession(state, wallTime()).accountId,
      scopeKey(scope),
      commandName,
      commandOptions.idempotencyKey,
    ]);
    const fingerprint = JSON.stringify([
      payload,
      commandOptions.expectedRevision ?? null,
    ]);
    const prior = state.idempotency[key];
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Refusal(
          "conflict",
          "This idempotency key was used with different input.",
        );
      return structuredClone(prior.value) as T;
    }
    const value = execute();
    state.idempotency[key] = { fingerprint, value: structuredClone(value) };
    return value;
  }
  function transition(
    context: RequestContext,
    operationId: string,
    commandOptions: CommandOptions,
    retry: boolean,
  ): Promise<Result<Operation>> {
    return run(
      (state) => {
        const record = readOperation(state, context, operationId);
        return command(
          state,
          record.scope,
          retry ? "operation.retry" : "operation.cancel",
          { operationId },
          commandOptions,
          () => {
            if (commandOptions.expectedRevision !== record.revision)
              throw new Refusal(
                "conflict",
                "Operation changed. Reload and compare its revision before submitting again.",
              );
            const action = retry ? record.actions.retry : record.actions.cancel;
            if (!action.allowed) throw new Refusal("conflict", action.reason!);
            if (retry && record.kind === "environment.provision" && Object.values(state.operations).some(other =>
              other.record.id !== record.id && other.record.kind === "environment.provision" &&
              other.record.scope.environmentId === record.scope.environmentId &&
              ["queued", "running", "cancel_requested"].includes(other.record.state)))
              throw new Refusal("conflict", "Another provisioning operation is active for this environment. Finish or cancel it before retrying.");
            const stored = state.operations[operationId];
            const time = now(state.clock, wallTime());
            stored.record = {
              ...record,
              state: retry
                ? "queued"
                : record.state === "queued"
                  ? "cancelled"
                  : "cancel_requested",
              revision: nextRevision(record.revision),
              updatedAt: iso(time),
              error: undefined,
            };
            stored.deadline = time + 1000;
            if (retry) stored.failStep = null;
            reconcileProvisioning(state, stored.record);
            publish(
              state,
              stored.record,
              retry ? "operation.retry" : "operation.cancel",
              time,
            );
            return actions(stored.record, true);
          },
        );
      },
      {
        signal: context.signal,
        mutate: true,
        audit: {
          scope: context.scope,
          action: retry
            ? "operation.retry.refused"
            : "operation.cancel.refused",
          resourceId: operationId,
        },
      },
    );
  }

  const services: BrowserServices = {
    identity: createIdentityServices(run, wallTime),
    platform: createPlatformServices(run, wallTime),
    configuration: createConfigurationServices(run, wallTime),
    delivery: createDeliveryServices(run, wallTime, listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    data: createDataServices(run, wallTime),
    functions: createFunctionServices(run, wallTime),
    registry: createRegistryServices(run, wallTime),
    billing: createBillingServices(run, wallTime),
    operator: createOperatorServices(run, wallTime),
    appAuth: createAppAuthServices(run, wallTime),
    extensions: createExtensionServices(run, wallTime, listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
    session: {
      getSession: (context) =>
        run((state) => currentSession(state, wallTime()), {
          signal: context?.signal,
          fast: true,
        }),
      signOut: () =>
        run(
          (state, requestId) => {
            const session = currentSession(state, wallTime());
            if (session) accountAudit(state, session.accountId, "session.signout", requestId, now(state.clock, wallTime()));
            if (state.activeSessionId)
              state.sessions[state.activeSessionId].revoked = true;
            state.activeSessionId = null;
            state.accessRevision++;
          },
          { mutate: true, fast: true },
        ),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    catalog: {
      listOrganizations: (page, context) =>
        run(
          (state) => {
            const session = requireSession(state, wallTime());
            const orgs = Object.values(state.organizations).filter((org) =>
              Object.values(state.memberships).some(
                (m) =>
                  m.active &&
                  m.accountId === session.accountId &&
                  m.orgId === org.id,
              ),
            );
            return paginate(orgs, page, visibility(state));
          },
          { signal: context?.signal },
        ),
      resolveScope: (context) =>
        run((state) => resolveScope(state, context.scope, wallTime()), {
          signal: context.signal,
          target: "catalog.resolve",
        }),
      listProjects: (context, page) =>
        run(
          (state) => {
            requirePermission(
              state,
              context.scope,
              "metadata.read",
              wallTime(),
            );
            const projects = Object.values(state.projects).filter((project) => {
              if (project.orgId !== context.scope.orgId) return false;
              try {
                resolveScope(
                  state,
                  { orgId: project.orgId, projectId: project.id },
                  wallTime(),
                );
                return true;
              } catch {
                return false;
              }
            });
            return paginate(projects, page, visibility(state, context.scope));
          },
          { signal: context.signal },
        ),
      listEnvironments: (context, page) =>
        run(
          (state) => {
            requirePermission(
              state,
              context.scope,
              "metadata.read",
              wallTime(),
            );
            if (!context.scope.projectId)
              throw new Refusal("validation", "A project is required.");
            return paginate(
              Object.values(state.environments).filter(
                (env) => env.projectId === context.scope.projectId,
              ),
              page,
              visibility(state, context.scope),
            );
          },
          { signal: context.signal },
        ),
    },
    capabilities: {
      getAvailableCapabilities: (context) =>
        run(
          (state): readonly Capability[] => {
            resolveScope(state, context.scope, wallTime());
            return [
              {
                id: "foundation",
                owner: "cloud" as const,
                available: true,
                limits: {
                  pageSize: 100,
                  mode: "mock",
                  targetTriple: "x86_64-pc-windows-msvc",
                  defaultInstaller: "nsis",
                  optionalInstaller: "wix",
                },
              },
              { id: "billing", owner: "cloud" as const, available: true, limits: { prices: "fictional fixtures", buildMinutes: "free 60 / pro 6000", provider: "simulated events only" } },
              { id: "operators", owner: "cloud" as const, available: true, limits: { audience: "separate operator fixture", customerDataAccess: "never implicit" } },
              { id: "registry", owner: "registry" as const, available: true, limits: { targetTriple: "x86_64-pc-windows-msvc", artifacts: "explicit synthetic fixtures", resolution: "exact version and digest", sourceSync: "simulated proposal only" } },
              { id: "identity", owner: "cloud" as const, available: true },
              { id: "data-extensions", owner: "database" as const, available: true, limits: { binaryBytesPerEnvironment: 10000000, vectorDimensions: 128, vectorPoints: 1000, realtimeReplayEvents: 200, migrations: "bounded CREATE and reviewed DROP fixtures" } },
              { id: "functions", owner: "database" as const, available: true, limits: { execution: "named fixture handlers; source never executed", triggers: "HTTP console and schedules", payloadBytes: 16384, timeoutMs: 30000, concurrency: 4 } },
              { id: "functions.database-triggers", owner: "database" as const, available: false, reason: "Database-event commit and delivery semantics are not implemented." },
              { id: "backup.pitr", owner: "database" as const, available: false, reason: "Point-in-time recovery and cross-service transactional snapshots are not supported." },
              { id: "database", owner: "database" as const, available: true, limits: { schema: "public", sql: "bounded fixture grammar", importRows: 1000, sqlResultRows: 100 } },
              { id: "app-auth", owner: "cloud" as const, available: true, limits: { providers: "email magic link, OAuth fixture", audience: "realm-scoped app", password: "unavailable v1" } },
              { id: "configuration", owner: "cloud" as const, available: true },
              { id: "builds", owner: "cloud" as const, available: true, limits: { targetTriple: "x86_64-pc-windows-msvc", execution: "simulated", maxAttempts: 3 } },
              { id: "releases", owner: "cloud" as const, available: true, limits: { clientProtocol: "carbon-polling-v1 fixture", payload: "full_update", discovery: "polling", signing: "metadata-only" } },
              { id: "client.pause-withdrawal", owner: "cloud" as const, available: true, limits: { mode: "simulated polling-v1 metadata; actual client interoperability unverified" } },
              { id: "client.telemetry", owner: "cloud" as const, available: false, reason: "No live fleet observations or delivery acknowledgements." },
              { id: "client.downgrade", owner: "cloud" as const, available: false, reason: "Channel rollback changes future discovery only; installed client downgrade is unverified." },
              {
                id: "client.forced-update",
                owner: "cloud" as const,
                available: false,
                reason:
                  "No supported client contract; requires a future integration decision.",
              },
            ] satisfies readonly Capability[];
          },
          { signal: context.signal },
        ),
    },
    operations: {
      get: (context, operationId) =>
        run((state) => readOperation(state, context, operationId), {
          signal: context.signal,
        }),
      list: (context, page) =>
        run(
          (state) => {
            requirePermission(
              state,
              context.scope,
              "metadata.read",
              wallTime(),
            );
            const records = Object.values(state.operations)
              .filter((stored) =>
                containsScope(context.scope, stored.record.scope),
              )
              .flatMap((stored) => {
                try {
                  return [readOperation(state, context, stored.record.id)];
                } catch {
                  return [];
                }
              });
            return paginate(records, page, visibility(state, context.scope));
          },
          { signal: context.signal },
        ),
      requestCancel: (context, operationId, commandOptions) =>
        transition(context, operationId, commandOptions, false),
      retryAllowedStep: (context, operationId, commandOptions) =>
        transition(context, operationId, commandOptions, true),
    },
    activity: {
      listAudit: (context, page) =>
        run(
          (state) => {
            requirePermission(state, context.scope, "audit.read", wallTime());
            const records = Object.values(state.audits).filter((audit) => {
              if (!containsScope(context.scope, audit.scope)) return false;
              if (page?.actorId && audit.actorId !== page.actorId) return false;
              if (page?.action && !audit.action.toLowerCase().includes(page.action.toLowerCase())) return false;
              if (page?.outcome && audit.outcome !== page.outcome) return false;
              if (page?.projectId && audit.scope.projectId !== page.projectId) return false;
              if (page?.environmentId && audit.scope.environmentId !== page.environmentId) return false;
              try {
                requirePermission(state, audit.scope, "audit.read", wallTime());
                return true;
              } catch {
                return false;
              }
            });
            return paginate(records, page, `${visibility(state, context.scope)}:${JSON.stringify([page?.actorId, page?.action, page?.outcome, page?.projectId, page?.environmentId])}`);
          },
          { signal: context.signal },
        ),
    },
    events: {
      subscribe: async (context, cursor, listener) => {
        let position = cursor === undefined ? -1 : Number(cursor);
        if (
          cursor !== undefined &&
          (!/^\d+$/.test(cursor) || !Number.isSafeInteger(position))
        )
          return {
            ok: false,
            error: {
              code: "validation",
              message: "Invalid event cursor.",
              requestId: "mock:subscribe",
            },
          };
        const initial = await run(
          (state) => {
            requirePermission(
              state,
              context.scope,
              "metadata.read",
              wallTime(),
            );
            return {
              sequence: state.sequence,
              session: currentSession(state, wallTime())!.id,
            };
          },
          { signal: context.signal },
        );
        if (!initial.ok) return initial;
        let closed = false;
        let pending = Promise.resolve();
        const stop = () => {
          closed = true;
          listeners.delete(onChange);
          context.signal?.removeEventListener("abort", stop);
        };
        const pump = () => {
          pending = pending.then(async () => {
            if (closed) return;
            const result = await run(
              (state) => {
                requirePermission(
                  state,
                  context.scope,
                  "metadata.read",
                  wallTime(),
                );
                if (
                  currentSession(state, wallTime())!.id !==
                  initial.value.session
                )
                  throw new Refusal(
                    "unauthenticated",
                    "Subscription identity changed.",
                  );
                const gap = position > state.sequence;
                if (position < 0 || gap) position = state.sequence;
                const events = Object.values(state.events).filter((event) => {
                  if (
                    Number(event.cursor) <= position ||
                    !containsScope(context.scope, event.scope)
                  )
                    return false;
                  try {
                    requirePermission(
                      state,
                      event.scope,
                      "metadata.read",
                      wallTime(),
                    );
                    return true;
                  } catch {
                    return false;
                  }
                });
                return {
                  state: gap ? "gap" : "connected",
                  cursor: String(state.sequence),
                  events,
                } satisfies SubscriptionMessage;
              },
              { fast: true },
            );
            if (closed) return;
            if (!result.ok) {
              stop();
              listener({
                state: "closed",
                cursor: String(Math.max(0, position)),
                events: [],
                error: result.error,
              });
            } else {
              position = Number(result.value.cursor);
              listener(result.value);
            }
          });
        };
        const onChange = () => pump();
        listeners.add(onChange);
        context.signal?.addEventListener("abort", stop, { once: true });
        if (context.signal?.aborted) stop();
        else pump();
        return ok(stop);
      },
    },
  };
  const tools: MockTools = {
    setDeliveryEvidence: (scope, status) => run(state => {
      requirePermission(state, scope, "metadata.read", wallTime());
      if (!scope.projectId || !["not_reported", "simulated", "offline", "stale"].includes(status)) throw new Refusal("validation", "Select a project and supported evidence state.");
      const time = now(state.clock, wallTime());
      for (const channel of Object.values(deliveryState(state).channels).filter(c => c.projectId === scope.projectId)) Object.assign(channel, {
        observations: { status, population: status === "not_reported" ? null : 1000, eligible: status === "not_reported" ? null : Math.floor(1000 * channel.rollout / 100), lastReportedAt: status === "not_reported" ? undefined : iso(time - (status === "stale" ? 600_000 : 0)), detail: status === "not_reported" ? "No delivery observations reported." : `${status}: deterministic fixture population only, not acknowledgements or a live installed fleet.` }, revision: nextRevision(channel.revision),
      });
      deliveryEvent(state, scope, "mock-tool", scope.projectId, "mock.delivery.evidence", time);
    }, { mutate: true, fast: true }),
    deliveryScenario: (scenario) => run(state => {
      deliveryState(state).scenario = scenario;
    }, { mutate: true, fast: true }),
    advanceDeliverySource: (scope, version) => run(state => {
      requirePermission(state, scope, "resources.configure", wallTime());
      if (!scope.projectId || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Refusal("validation", "Select a project and enter a semantic version such as 1.1.0.");
      const data = deliveryState(state), item = data.settings[scope.projectId];
      Object.assign(item, { manifest: { ...item.manifest, version, digest: digest(`${scope.projectId}:manifest:${version}`) }, revision: nextRevision(item.revision) });
      const repo = state.configuration!.repositories[scope.projectId]; Object.assign(repo, { revision: nextRevision(repo.revision) });
      deliveryEvent(state, scope, "mock-tool", scope.projectId, "mock.repository.source.advanced", now(state.clock, wallTime()));
    }, { mutate: true, fast: true }),
    inbox: () => run(state => {
      const data = identityState(state);
      return {
        messages: [
          ...Object.values(data.challenges).map(c => ({ id: c.id, email: c.email, purpose: c.purpose, href: `/auth/callback?token=${encodeURIComponent(c.token)}`, status: c.used ? "used" : Date.parse(c.expiresAt) <= now(state.clock, wallTime()) ? "expired" : "pending", expiresAt: c.expiresAt })),
          ...Object.values(data.invitations).map(i => ({ id: i.id, email: i.email, purpose: "invitation", href: `/invites/${i.token}`, status: i.status, expiresAt: i.expiresAt })),
        ],
        authenticators: Object.values(data.accounts).filter(a => a.mfa || a.enrollment).map(a => ({ accountId: a.id, email: a.email, code: mfaCode(a.id) })),
        provisionFailure: data.nextProvisionFailure,
      };
    }, { fast: true }),
    failNextProvision: () => run(state => { identityState(state).nextProvisionFailure = true; }, { mutate: true, fast: true }),
    inspect: () =>
      run(
        (state) => ({
          now: iso(now(state.clock, wallTime())),
          paused: state.clock.paused,
          latencyMs: state.latencyMs,
          failure: state.failure
            ? `${state.failure.target}: ${state.failure.error.code}`
            : null,
          identities: Object.values(state.accounts).filter(a => identityState(state).accounts[a.id]?.status === "active"),
          deliveryScenario: deliveryState(state).scenario,
        }),
        { fast: true },
      ),
    selectIdentity: (accountId) =>
      run(
        (state) => {
          if (
            accountId &&
            !state.accounts[accountId]
          )
            throw new Refusal("validation", "Unknown fixture identity.");
          state.accessRevision++;
          if (!accountId) state.activeSessionId = null;
          else {
            const session = identities.some(i => i.id === accountId) ? fixtureSession(
              state,
              accountId,
              now(state.clock, wallTime()),
            ) : { id: id(state, "session"), accountId, name: state.accounts[accountId].name, audience: "dashboard" as const, expiresAt: iso(now(state.clock, wallTime()) + 3_600_000), visibilityKey: "", revoked: false };
            state.sessions[session.id] = session;
            state.activeSessionId = session.id;
          }
        },
        { mutate: true, fast: true },
      ),
    setClock: (paused, advanceMs = 0) =>
      run(
        (state) => {
          if (
            !Number.isFinite(advanceMs) ||
            advanceMs < 0 ||
            advanceMs > 31_536_000_000
          )
            throw new Refusal(
              "validation",
              "Advance must be between zero and one simulated year.",
            );
          setClock(state.clock, wallTime(), paused, advanceMs);
          reconcile(state, wallTime());
        },
        { mutate: true, fast: true },
      ),
    setLatency: (ms) =>
      run(
        (state) => {
          if (!Number.isInteger(ms) || ms < 0 || ms > 10_000)
            throw new Refusal("validation", "Latency must be 0–10000 ms.");
          state.latencyMs = ms;
        },
        { mutate: true, fast: true },
      ),
    revokeMembership: (scope) =>
      run(
        (state, requestId) => {
          const actor = requireSession(state, wallTime());
          const resolved = resolveScope(state, scope, wallTime());
          const member = Object.values(state.memberships).find(
            (m) =>
              m.active &&
              m.accountId === actor.accountId &&
              m.orgId === resolved.organization.id,
          )!;
          if (
            member.role === "Owner" &&
            Object.values(state.memberships).filter(
              (m) => m.active && m.orgId === member.orgId && m.role === "Owner",
            ).length <= 1
          )
            throw new Refusal(
              "conflict",
              "The last owner cannot be removed. Choose the restricted developer fixture to demonstrate revocation.",
            );
          member.active = false;
          state.accessRevision++;
          const auditId = id(state, "audit");
          state.audits[auditId] = {
            id: auditId,
            scope: { orgId: scope.orgId },
            actorId: "mock-tool",
            action: "mock.membership.revoked",
            resourceId: member.id,
            outcome: "succeeded",
            occurredAt: iso(now(state.clock, wallTime())),
            requestId,
          };
        },
        { mutate: true, fast: true },
      ),
    injectFailure: (target, code, phase = "before") =>
      run(
        (state) => {
          if (
            phase === "after" &&
            (target !== "foundation.start" || code !== "unavailable")
          )
            throw new Refusal(
              "validation",
              "Lost-response injection requires foundation.start and unavailable.",
            );
          state.failure = code
            ? {
                target,
                phase,
                error: {
                  code,
                  message: `Injected ${code} for ${target}. Retry after this one-shot failure.`,
                  requestId: "mock:injected",
                  ...(code === "rate_limited" ? { retryAfterMs: 1000 } : {}),
                },
              }
            : null;
        },
        { mutate: true, fast: true },
      ),
    startCheck: (scope, outcome, commandOptions) =>
      run(
        (state, requestId) =>
          command(
            state,
            scope,
            "foundation.start",
            { outcome },
            commandOptions,
            () => {
              if (outcome !== "success" && outcome !== "partial_failure")
                throw new Refusal("validation", "Unsupported check outcome.");
              const time = now(state.clock, wallTime());
              const operationId = id(state, "operation");
              const record: Operation = {
                id: operationId,
                kind: "foundation.check",
                scope,
                actorId: requireSession(state, wallTime()).accountId,
                state: "queued",
                completedSteps: 0,
                totalSteps: 3,
                steps: [
                  "Cloud catalog fixture",
                  "Database binding fixture",
                  "Registry binding fixture",
                ],
                revision: "r1",
                createdAt: iso(time),
                updatedAt: iso(time),
                requestId,
                actions: {
                  cancel: { allowed: true },
                  retry: {
                    allowed: false,
                    reason: "Only a failed step can be retried.",
                  },
                },
              };
              state.operations[operationId] = {
                record,
                deadline: time + 1000,
                failStep: outcome === "partial_failure" ? 1 : null,
              };
              publish(state, record, "operation.created", time);
              return record;
            },
          ),
        {
          mutate: true,
          target: "foundation.start",
          audit: { scope, action: "foundation.start.unconfirmed" },
        },
      ),
    reset: async (confirmation) => {
      if (confirmation !== "RESET MOCK")
        return {
          ok: false,
          error: {
            code: "validation",
            message:
              "Type RESET MOCK to confirm replacing this fake workspace in all tabs.",
            requestId: "mock:reset",
          },
        };
      try {
        const seed = seedFoundation(wallTime());
        // Epoch survives reset so other tabs always clear old visibility and cursors.
        await persistence.transact((state) => {
          seed.accessRevision = state.accessRevision + 1;
          seed.revision = state.revision + 1;
          Object.assign(state, seed);
          delete state.delivery;
          delete state.functions;
          return { value: undefined, changed: true };
        });
        lastRevision = seed.revision;
        lastAccess = seed.accessRevision;
        notify({ security: true, scopes: [] });
        channel?.postMessage({ reset: true });
        return ok(undefined);
      } catch (cause) {
        return { ok: false, error: error(cause, "mock:reset") };
      }
    },
  };
  const timer =
    options.autoTick === false
      ? undefined
      : setInterval(() => {
          void tick();
        }, 500);
  return {
    services,
    tools,
    tick,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      listeners.clear();
      channel?.close();
      persistence.close();
    },
  };
}
