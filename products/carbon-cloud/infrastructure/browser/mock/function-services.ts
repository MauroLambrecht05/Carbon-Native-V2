import type { FunctionService, Invocation } from "../../../presentation/framework/services/function-contracts";
import type { CommandReceipt } from "../../../presentation/framework/services/identity-contracts";
import type { Scope } from "../../../presentation/framework/services/contracts";
import { Refusal, requireSession } from "./access";
import { now } from "./clock";
import { checkRevision, dataAudit, once, production, type Run } from "./data-common";
import { bump, label, sameScope, scoped } from "./extension-state";
import { compatible, deployment, draft, enqueue, functionAccess, limits, nextOccurrence, pending, safeInput, serviceCredential, syncFunctionBindings, validateConfig } from "./function-engine";
import { functions } from "./function-state";
import { allocate } from "./identity-state";
import { paginate } from "./pagination";

export function createFunctionServices(run: Run, wall: () => number): FunctionService {
  const safeSummary = (r: Invocation) => { const { input: _i, output: _o, logs: _l, ...summary } = r; return { ...summary, redacted: true }; };
  return {
    limits: context => run(state => { functionAccess(state, context.scope, "metadata.read", wall()); return limits; }, { signal: context.signal }),
    list: (context, page) => run(state => {
      functionAccess(state, context.scope, "metadata.read", wall());
      return paginate(Object.values(functions(state).functions).filter(f => sameScope(f.scope, context.scope)).map(({ draft: _draft, ...summary }) => summary), page, `${requireSession(state, wall()).visibilityKey}:${JSON.stringify(context.scope)}:functions`);
    }, { signal: context.signal }),
    get: (context, id) => run(state => { functionAccess(state, context.scope, "metadata.read", wall()); return scoped(functions(state).functions, context.scope, id); }, { signal: context.signal }),
    deployments: (context, id, page) => run(state => {
      functionAccess(state, context.scope, "metadata.read", wall()); scoped(functions(state).functions, context.scope, id);
      return paginate(Object.values(functions(state).deployments).filter(d => d.functionId === id && sameScope(d.scope, context.scope)), page, `${requireSession(state, wall()).visibilityKey}:${id}:deployments`);
    }, { signal: context.signal }),
    command: (context, input, confirmation, options) => run((state, requestId) => {
      functionAccess(state, context.scope, "resources.configure", wall()); if (input.kind !== "promote") production(state, context.scope, confirmation, wall());
      const session = requireSession(state, wall()), data = functions(state);
      return once(state, context.scope, session.accountId, "function.command", { input, confirmation }, options, () => {
        let receipt: CommandReceipt;
        if (input.kind === "create") {
          const name = label(input.name);
          if (Object.values(data.functions).some(f => sameScope(f.scope, context.scope) && f.name === name && f.status !== "deleted")) throw new Refusal("conflict", "Function name already exists.");
          const id = allocate(state, "function");
          data.functions[id] = { id, scope: context.scope, name, status: "enabled", draft: draft(state, context.scope, input.source, input.repositoryPath, input.config, wall()), revision: "r1", createdAt: new Date(now(state.clock, wall())).toISOString() };
          receipt = { message: "Function draft created. Deploy it before invoking.", resourceId: id };
        } else {
          const fn = scoped(data.functions, context.scope, input.id);
          if (fn.status === "deleted") throw new Refusal("conflict", "Deleted function history is retained and cannot be changed.");
          if (input.kind.startsWith("schedule.") && "scheduleId" in input && input.scheduleId) checkRevision(scoped(data.schedules, context.scope, input.scheduleId).revision, options);
          else checkRevision(fn.revision, options);
          receipt = { message: "Function updated.", resourceId: fn.id };
          if (input.kind === "save") {
            fn.draft = draft(state, context.scope, input.source, input.repositoryPath, input.config, wall(), bump(fn.draft.revision)); fn.revision = bump(fn.revision);
            receipt = { ...receipt, message: "Draft saved. The active deployment is unchanged." };
          } else if (input.kind === "deploy" || input.kind === "promote") {
            let target = fn, source;
            if (input.kind === "promote") {
              if (!input.reviewed) throw new Refusal("validation", "Review target configuration and secret bindings before promotion.");
              source = scoped(data.deployments, context.scope, input.deploymentId);
              if (source.functionId !== fn.id) throw new Refusal("not_found", "Deployment does not belong to this function.");
              const targetScope: Scope = { ...context.scope, environmentId: input.targetEnvironmentId };
              if (sameScope(targetScope, context.scope)) throw new Refusal("validation", "Choose a different target environment.");
              functionAccess(state, targetScope, "resources.configure", wall()); production(state, targetScope, confirmation, wall());
              if (input.targetFunctionId) {
                target = scoped(data.functions, targetScope, input.targetFunctionId);
                checkRevision(target.revision, { ...options, expectedRevision: input.targetRevision });
              } else {
                if (Object.values(data.functions).some(f => sameScope(f.scope, targetScope) && f.name === fn.name && f.status !== "deleted")) throw new Refusal("conflict", "Select the existing target function and its current revision.");
                const id = allocate(state, "function");
                target = data.functions[id] = { id, scope: targetScope, name: fn.name, status: "enabled", draft: structuredClone(fn.draft), revision: "r1", createdAt: new Date(now(state.clock, wall())).toISOString() };
              }
              // Build a target snapshot without silently overwriting the target's saved draft.
            }
            if (target.status !== "enabled") throw new Refusal("conflict", "Enable the target function before deploying.");
            if (Object.entries(data.jobs).some(([id, j]) => j.deployment.functionId === target.id && pending(state.operations[id].record.state))) throw new Refusal("conflict", "Another deployment is pending for this function.");
            const candidate = input.kind === "promote" ? { ...target, draft: draft(state, target.scope, source!.source, source!.repositoryPath, input.config, wall()) } : target;
            const snapshot = deployment(state, candidate, wall(), session.accountId, source);
            if (input.kind === "promote" && !input.targetFunctionId) target.draft = candidate.draft;
            const id = allocate(state, "operation"), time = now(state.clock, wall());
            data.jobs[id] = { scope: target.scope, sessionId: session.id, deadline: time + 1000, functionRevision: target.revision, production: confirmation, deployment: snapshot, simulateFailure: input.kind === "deploy" && input.simulateFailure };
            state.operations[id] = { deadline: time + 1000, failStep: null, record: { id, kind: "function.deploy", scope: target.scope, actorId: session.accountId, state: "queued", completedSteps: 0, totalSteps: 3, steps: ["Package fixture", "Validate bindings", "Activate snapshot"], revision: "r1", createdAt: new Date(time).toISOString(), updatedAt: new Date(time).toISOString(), requestId, actions: { cancel: { allowed: false, reason: "Use function deployment cancellation." }, retry: { allowed: false, reason: "Review current bindings and submit a new deployment." } } } };
            receipt = { message: "Deployment queued. Previous active deployment remains until activation succeeds.", operationId: id, operation: state.operations[id].record, resourceId: target.id };
            dataAudit(state, target.scope, session.accountId, "function.deployment.queued", id, requestId, wall());
          } else if (input.kind === "rollback") {
            const d = scoped(data.deployments, context.scope, input.deploymentId);
            if (d.functionId !== fn.id) throw new Refusal("not_found", "Deployment does not belong to this function.");
            if (fn.status !== "enabled") throw new Refusal("conflict", "Enable the function before rollback.");
            compatible(state, d); fn.activeDeploymentId = d.id; fn.revision = bump(fn.revision);
            receipt = { ...receipt, message: "Active deployment changed. Earlier invocation side effects are not undone." };
          } else if (input.kind === "status") {
            if (!["enabled", "disabled", "deleted"].includes(input.status) || input.confirmation !== fn.name) throw new Refusal("validation", "Confirm the exact function name and supported status.");
            if (input.status === "enabled") { validateConfig(state, fn.scope, fn.draft.config); if (fn.activeDeploymentId) compatible(state, data.deployments[fn.activeDeploymentId]); }
            fn.status = input.status; fn.revision = bump(fn.revision);
            if (fn.status !== "enabled") {
              for (const s of Object.values(data.schedules).filter(s => s.functionId === fn.id)) { s.enabled = false; s.revision = bump(s.revision); }
              for (const stored of Object.values(data.invocations).filter(i => i.record.functionId === fn.id && pending(i.record.state))) { stored.record.state = "cancel_requested"; stored.record.revision = bump(stored.record.revision); stored.deadline = now(state.clock, wall()) + 1; }
              for (const [id, j] of Object.entries(data.jobs).filter(([, j]) => j.deployment.functionId === fn.id)) if (pending(state.operations[id].record.state)) { Object.assign(state.operations[id].record, { state: "cancel_requested", revision: bump(state.operations[id].record.revision) }); j.deadline = now(state.clock, wall()) + 1; }
            }
            receipt = { ...receipt, message: `${fn.status}. Schedules stopped and pending work requests cancellation; history is retained.` };
          } else if (input.kind === "schedule.save") {
            if (!["skip", "catch-up-once"].includes(input.missed) || !["skip", "allow"].includes(input.overlap) || typeof input.enabled !== "boolean") throw new Refusal("validation", "Choose enabled, missed-run and overlap policies.");
            if (input.enabled && (fn.status !== "enabled" || !fn.activeDeploymentId || data.deployments[fn.activeDeploymentId].config.authorization !== "service-credential")) throw new Refusal("conflict", "Schedules require an enabled deployment with service-credential authorization.");
            if (input.enabled) serviceCredential(state, context.scope, input.credentialId, wall(), !!data.deployments[fn.activeDeploymentId!]?.config.resource);
            const existing = input.scheduleId ? scoped(data.schedules, context.scope, input.scheduleId) : undefined;
            if (existing && existing.functionId !== fn.id) throw new Refusal("not_found", "Schedule not found for this function.");
            const id = existing?.id ?? allocate(state, "function_schedule");
            data.schedules[id] = { id, scope: context.scope, functionId: fn.id, name: label(input.name), cron: input.cron, timezone: input.timezone, enabled: input.enabled, missed: input.missed, overlap: input.overlap, credentialId: input.credentialId, nextRunAt: nextOccurrence(input.cron, input.timezone, now(state.clock, wall())), revision: existing ? bump(existing.revision) : "r1" };
            receipt = { message: "Schedule saved. Runs use the active deployment and a narrow backend credential.", resourceId: id };
          } else if (input.kind === "schedule.delete") {
            const s = scoped(data.schedules, context.scope, input.scheduleId);
            if (s.functionId !== fn.id) throw new Refusal("not_found", "Schedule not found for this function.");
            delete data.schedules[s.id]; receipt = { ...receipt, message: "Schedule removed. Invocation history is retained." };
          } else throw new Refusal("unsupported_operation", "Unsupported function command.");
        }
        syncFunctionBindings(state); dataAudit(state, context.scope, session.accountId, `function.${input.kind}`, receipt.resourceId!, requestId, wall()); return receipt;
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: `function.${input.kind}` } }),
    invoke: (context, id, input, confirmation, options) => run((state, requestId) => {
      functionAccess(state, context.scope, "data.write", wall()); production(state, context.scope, confirmation, wall());
      const data = functions(state), fn = scoped(data.functions, context.scope, id), session = requireSession(state, wall());
      return once(state, context.scope, session.accountId, "function.invoke", { id, input: safeInput(input), confirmation }, options, () => {
        checkRevision(fn.revision, options);
        if (!fn.activeDeploymentId) throw new Refusal("conflict", "Deploy the function before invoking.");
        const invocationId = enqueue(state, fn, data.deployments[fn.activeDeploymentId], input, wall(), requestId, confirmation, session.id);
        syncFunctionBindings(state); return { message: "Invocation queued. Source is not executed; payload is bounded and redacted before fixture handling.", resourceId: invocationId };
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: "function.invoke" } }),
    invocations: (context, id, query) => run(state => {
      functionAccess(state, context.scope, "metadata.read", wall()); scoped(functions(state).functions, context.scope, id);
      for (const date of [query?.since, query?.until]) if (date && !Number.isFinite(Date.parse(date))) throw new Refusal("validation", "Use ISO timestamps for invocation filters.");
      const rows = Object.values(functions(state).invocations).map(i => i.record).filter(r => sameScope(r.scope, context.scope) && r.functionId === id && (!query?.status || r.state === query.status) && (!query?.trigger || r.trigger === query.trigger) && (!query?.since || Date.parse(r.createdAt) >= Date.parse(query.since)) && (!query?.until || Date.parse(r.createdAt) <= Date.parse(query.until)));
      return paginate(rows.map(safeSummary), query, `${requireSession(state, wall()).visibilityKey}:${id}:${JSON.stringify([query?.status, query?.trigger, query?.since, query?.until])}`);
    }, { signal: context.signal }),
    invocation: (context, id, invocationId, content) => run((state, requestId) => {
      functionAccess(state, context.scope, content ? "data.read" : "metadata.read", wall());
      scoped(functions(state).functions, context.scope, id);
      const stored = functions(state).invocations[invocationId];
      if (!stored || !sameScope(stored.record.scope, context.scope) || stored.record.functionId !== id) throw new Refusal("not_found", "Invocation not found.");
      if (!content) return safeSummary(stored.record);
      dataAudit(state, context.scope, requireSession(state, wall()).accountId, "function.invocation.read", invocationId, requestId, wall());
      return { ...stored.record, input: stored.input, redacted: true };
    }, { signal: context.signal, mutate: content, quiet: true }),
    retry: (context, id, invocationId, confirmation, options) => run((state, requestId) => {
      functionAccess(state, context.scope, "data.write", wall()); functionAccess(state, context.scope, "data.read", wall()); production(state, context.scope, confirmation, wall());
      const data = functions(state), fn = scoped(data.functions, context.scope, id), original = data.invocations[invocationId], session = requireSession(state, wall());
      if (!original || original.record.functionId !== fn.id) throw new Refusal("not_found", "Invocation not found.");
      return once(state, context.scope, session.accountId, "function.retry", { id, invocationId, confirmation }, options, () => {
        checkRevision(original.record.revision, options);
        if (!["failed", "timed_out", "cancelled"].includes(original.record.state)) throw new Refusal("conflict", "Only failed, timed-out or cancelled invocations may be retried.");
        const resourceId = enqueue(state, fn, data.deployments[original.record.deploymentId], original.input, wall(), requestId, confirmation, session.id, "retry", invocationId);
        syncFunctionBindings(state); return { resourceId, message: "New invocation of the original deployment queued. Business key is forwarded; repeated side effects are possible." };
      });
    }, { signal: context.signal, mutate: true }),
    cancel: (context, id, invocationId, confirmation, options) => run((state, requestId) => {
      functionAccess(state, context.scope, "data.write", wall()); production(state, context.scope, confirmation, wall());
      scoped(functions(state).functions, context.scope, id);
      const stored = functions(state).invocations[invocationId], session = requireSession(state, wall());
      if (!stored || stored.record.functionId !== id) throw new Refusal("not_found", "Invocation not found.");
      return once(state, context.scope, session.accountId, "function.cancel", { invocationId, confirmation }, options, () => {
        checkRevision(stored.record.revision, options);
        if (!["queued", "running"].includes(stored.record.state)) throw new Refusal("conflict", "Invocation is terminal or cancellation was already requested.");
        stored.record.state = "cancel_requested"; stored.record.revision = bump(stored.record.revision); stored.deadline = now(state.clock, wall()) + 1;
        dataAudit(state, context.scope, session.accountId, "function.invocation.cancel_requested", invocationId, requestId, wall()); return { message: "Cancellation requested; already committed side effects cannot be undone.", resourceId: invocationId };
      });
    }, { signal: context.signal, mutate: true }),
    cancelDeployment: (context, id, confirmation, options) => run((state, requestId) => {
      functionAccess(state, context.scope, "resources.configure", wall()); production(state, context.scope, confirmation, wall());
      const job = functions(state).jobs[id], session = requireSession(state, wall());
      if (!job || !sameScope(job.scope, context.scope)) throw new Refusal("not_found", "Deployment operation not found.");
      return once(state, context.scope, session.accountId, "function.deployment.cancel", { id, confirmation }, options, () => {
        const op = state.operations[id].record; checkRevision(op.revision, options);
        if (!["queued", "running"].includes(op.state)) throw new Refusal("conflict", "Operation is terminal or cancellation was already requested.");
        Object.assign(op, { state: "cancel_requested", revision: bump(op.revision) }); job.deadline = now(state.clock, wall()) + 1;
        dataAudit(state, context.scope, session.accountId, "function.deployment.cancel_requested", id, requestId, wall()); return { message: "Deployment cancellation requested.", operationId: id };
      });
    }, { signal: context.signal, mutate: true }),
    schedules: (context, id, page) => run(state => {
      functionAccess(state, context.scope, "metadata.read", wall()); scoped(functions(state).functions, context.scope, id);
      return paginate(Object.values(functions(state).schedules).filter(s => s.functionId === id && sameScope(s.scope, context.scope)), page, `${requireSession(state, wall()).visibilityKey}:${id}:schedules`);
    }, { signal: context.signal }),
    previewSchedule: (context, cron, timezone) => run(state => {
      functionAccess(state, context.scope, "metadata.read", wall()); let time = now(state.clock, wall()); const next = [];
      for (let i = 0; i < 5; i++) { const occurrence = nextOccurrence(cron, timezone, time); next.push(occurrence); time = Date.parse(occurrence); }
      return { next, daylightSaving: "UTC minute scanning in the selected IANA timezone: repeated local DST minutes run twice; nonexistent local minutes are skipped. Missed runs coalesce at most once, never an unbounded replay." };
    }, { signal: context.signal }),
  };
}
