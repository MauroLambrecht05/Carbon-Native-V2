import type { Operation, Scope } from "../../../presentation/framework/services/contracts";
import type { Artifact, Build, BuildAttempt, BuildInputs, Channel, Preflight, Release, StageName } from "../../../presentation/framework/services/delivery-contracts";
import { now } from "./clock";
import { allocate, bump, identityState } from "./identity-state";
import { action, deliveryState, digest, stageNames, terminalBuild, type DeliveryScenario } from "./delivery-state";
import type { MockState } from "./store";

export const iso = (time: number) => new Date(time).toISOString();
export function deliveryEvent(state: MockState, scope: Scope, actorId: string, resourceId: string, event: string, time: number, requestId = "mock:scheduler", failed = false) {
  const id = allocate(state, "audit");
  state.audits[id] = { id, scope, actorId, resourceId, action: event, occurredAt: iso(time), requestId, outcome: failed ? "failed" : "succeeded" };
  const cursor = String(++state.sequence);
  state.events[`event_${cursor}`] = { id: `event_${cursor}`, cursor, scope, actorId, resourceId, action: event, revision: `r${cursor}`, occurredAt: iso(time) };
}
function notify(state: MockState, scope: Scope, accountId: string, resourceId: string, title: string, time: number, kind: "builds" | "releases") {
  const data = identityState(state);
  if (!data.accounts[accountId]?.notifications) return;
  const id = allocate(state, "notification");
  data.notifications[id] = { id, accountId, name: `${resourceId}: ${title}`, href: `/orgs/${scope.orgId}/projects/${scope.projectId}/${kind}/${resourceId}`, read: false, createdAt: iso(time) };
}
export function operation(state: MockState, scope: Scope, actorId: string, kind: Operation["kind"], steps: readonly string[], time: number, requestId: string) {
  const id = allocate(state, "operation");
  state.operations[id] = { record: { id, scope, actorId, kind, steps, state: "queued", completedSteps: 0, totalSteps: steps.length, revision: "r1", createdAt: iso(time), updatedAt: iso(time), requestId,
    actions: { cancel: action(false, "Use the resource's cancellation workflow."), retry: action(false, "Use the resource's retry workflow, including preflight and channel revision review.") } }, deadline: time + 1000, failStep: null };
  return id;
}
function syncOperation(state: MockState, id: string, status: Operation["state"], steps: number, time: number, error?: string) {
  const stored = state.operations[id];
  stored.record = { ...stored.record, state: status, completedSteps: steps, revision: bump(stored.record.revision), updatedAt: iso(time), error: error ? { code: "unavailable", message: error, requestId: stored.record.requestId } : undefined };
}
export function createBuild(state: MockState, scope: Scope, actorId: string, inputs: BuildInputs, time: number, requestId: string, trigger: Build["trigger"], failure: DeliveryScenario, retryOf?: string, deliveryId?: string) {
  const data = deliveryState(state), id = allocate(state, "build");
  const operationId = operation(state, scope, actorId, "windows.build", stageNames, time, requestId);
  const record: Build = { id, scope, actorId, revision: "r1", inputs: structuredClone(inputs), trigger, retryOf, deliveryId, status: "queued", queuedAt: iso(time), operationId,
    attempts: [newAttempt(state, 1)], artifactIds: [], queueMs: 0, runMs: 0, actions: { cancel: action(true), retry: action(false), draft: action(false) } };
  data.builds[id] = record; data.logs[id] = [];
  data.jobs[operationId] = { resourceId: id, deadline: time + 1000, failure };
  deliveryEvent(state, scope, actorId, id, `build.${trigger}.queued`, time, requestId);
  return record;
}
function newAttempt(state: MockState, number: number): BuildAttempt {
  return { id: allocate(state, "attempt"), number, status: "queued", stages: stageNames.map(name => ({ name, status: "pending" })) };
}
function log(state: MockState, build: Build, attempt: BuildAttempt, stage: StageName, text: string, time: number, error = false) {
  const logs = deliveryState(state).logs[build.id];
  logs.push({ sequence: logs.length + 1, attemptId: attempt.id, stage, stream: error ? "stderr" : "stdout", text, occurredAt: iso(time) });
}
function freeWorker(state: MockState, build: Build) {
  const data = deliveryState(state), worker = data.workers[build.attempts.at(-1)?.workerId ?? ""];
  if (worker?.runningBuildId === build.id) Object.assign(worker, { runningBuildId: undefined, status: worker.status === "draining" ? "offline" : worker.status, revision: bump(worker.revision) });
}
function meter(state: MockState, build: Build, attempt: BuildAttempt, time: number) {
  if (!attempt.startedAt) return;
  deliveryState(state).usage[attempt.id] ??= { orgId: build.scope.orgId, projectId: build.scope.projectId!, buildId: build.id, attemptId: attempt.id, minutes: Math.max(1, Math.ceil((time - Date.parse(attempt.startedAt)) / 60_000)) };
}
function finishBuild(state: MockState, build: Build, status: "failed" | "succeeded" | "cancelled", time: number, error?: string) {
  const attempt = build.attempts.at(-1)!;
  Object.assign(attempt, { status, finishedAt: iso(time), error });
  for (const stage of attempt.stages) if (stage.status === "running") Object.assign(stage, { status: status === "succeeded" ? "succeeded" : status, finishedAt: iso(time) });
  Object.assign(build, { status, finishedAt: iso(time), error, runMs: build.startedAt ? time - Date.parse(build.startedAt) : 0, revision: bump(build.revision) });
  meter(state, build, attempt, time); freeWorker(state, build);
  syncOperation(state, build.operationId, status, attempt.stages.filter(s => s.status === "succeeded").length, time, error);
  log(state, build, attempt, attempt.stages.find(s => s.status !== "succeeded")?.name ?? "finalize", error ?? `Build ${status}; workspace cleaned; task-scoped lease closed.`, time, status === "failed");
  deliveryEvent(state, build.scope, build.actorId, build.id, `build.${status}`, time, state.operations[build.operationId].record.requestId, status === "failed");
  notify(state, build.scope, build.actorId, build.id, `Windows build ${status}`, time, "builds");
}
export function cancelQueuedBuild(state: MockState, build: Build, time: number) { finishBuild(state, build, "cancelled", time); }
function makeArtifacts(state: MockState, build: Build, time: number) {
  const data = deliveryState(state);
  const certificate = build.inputs.signing.certificate;
  const signature = certificate.expiresAt && Date.parse(certificate.expiresAt) <= time ? "expired" : certificate.state;
  const key = build.inputs.signing.keys.find(k => k.state === "active");
  const artifacts: Artifact[] = [...build.inputs.formats.map(format => ({ format, payloadKind: "installer" as const, compatibility: "installer-only" as const })),
    { format: "zip" as const, payloadKind: "full_update" as const, compatibility: "carbon-polling-v1" as const }].map(item => {
    const id = allocate(state, "artifact");
    const name = `${build.inputs.manifest.appId}-${build.inputs.manifest.version}-${item.format}.fixture.txt`;
    const bytes = artifactBytes(build.id, id, name);
    return { id, buildId: build.id, scope: build.scope, revision: "r1", targetTriple: build.inputs.targetTriple, ...item, name, size: bytes.length, digest: digest(new TextDecoder().decode(bytes)), signature, keyId: key?.id,
      expiresAt: iso(time + 30 * 86_400_000), retention: "temporary", releaseIds: [], actions: { download: action(true), remove: action(true) } };
  });
  for (const artifact of artifacts) data.artifacts[artifact.id] = artifact;
  Object.assign(build, { artifactIds: artifacts.map(a => a.id) });
}
export function artifactBytes(buildId: string, artifactId: string, name: string) {
  return new TextEncoder().encode(`CARBON LOCAL FIXTURE — inert text, not an executable installer or update archive.\nBuild: ${buildId}\nArtifact: ${artifactId}\nName: ${name}\n`);
}
export function releaseReadiness(state: MockState, release: Release, time: number): Preflight {
  const data = deliveryState(state), build = data.builds[release.buildId], signing = data.signing[release.scope.projectId!], channel = data.channels[release.targetChannelId];
  const artifacts = release.artifactIds.map(id => data.artifacts[id]);
  const production = state.environments[release.environmentId]?.kind === "production" || channel?.name === "stable";
  const check = (name: string, passes: boolean, detail: string) => ({ name, state: passes ? "pass" as const : "blocked" as const, detail });
  const checks = [
    check("Successful immutable build", !!build && build.status === "succeeded", "A completed build is required."),
    check("Version matches binary metadata", build?.inputs.manifest.version === release.version, "Changing the source manifest version requires another build."),
    check("Unique version", !Object.values(data.releases).some(r => r.id !== release.id && r.scope.projectId === release.scope.projectId && r.version === release.version), "Versions remain reserved while present in release history."),
    check("Environment", !!build && build.scope.environmentId === release.environmentId && state.environments[release.environmentId]?.status === "ready" && state.projects[release.scope.projectId!]?.status !== "archived", "Release retains its build's environment; it must be ready."),
    check("Retained owned artifacts", artifacts.length > 0 && artifacts.every(a => a && a.buildId === release.buildId && !a.deletedAt && (a.retention === "release_retained" || Date.parse(a.expiresAt) > time)), "Every selected artifact must belong to this build and remain retained; published references protect assets beyond temporary retention."),
    check("Payload compatibility", release.compatibility === "carbon-polling-v1" && artifacts.some(a => a?.payloadKind === "full_update" && a.compatibility === release.compatibility), "Polling v1 requires a full update payload. An NSIS/MSI installer alone cannot be offered as an update."),
    check("Artifact integrity", artifacts.every(a => a && !["invalid", "expired", "unknown"].includes(a.signature)), "Invalid, expired or unknown signature verification blocks publication."),
    check("Production signing policy", !production || !signing.requireSignedProduction || artifacts.every(a => a?.signature === "signed"), "Stable and production require signed Windows artifacts."),
    check("Update signing key", !!signing.keys.find(k => k.state === "active") && artifacts.every(a => !a?.keyId || signing.keys.some(k => k.id === a.keyId && (k.state === "active" || k.state === "overlap" && Date.parse(k.overlapUntil!) > time))), "Artifact trust keys must be active or within the supported overlap window."),
    check("Dependency trust", !!build && build.inputs.plugins.every(p => p.trust === "verified" && p.compatible && !data.plugins[release.scope.projectId!].some(current => current.id === p.id && current.trust === "revoked")), "Revoked or incompatible dependency metadata blocks publication."),
    check("Migration compatibility", release.migration !== "unknown", "A compatible or explicitly forward-only migration declaration is required; rollback of forward-only migrations is blocked."),
    check("Channel", !!channel && channel.projectId === release.scope.projectId, "Select a channel belonging to this project."),
  ];
  const allChecks: Preflight["checks"][number][] = [...checks];
  if (!production && artifacts.some(a => a?.signature === "not_configured")) allChecks.push({ name: "Unsigned development output", state: "warning", detail: "Permitted outside stable/production; Windows certificate is not configured." });
  return { allowed: allChecks.every(c => c.state !== "blocked"), checks: allChecks, revision: `${release.revision}:${channel?.revision}:${signing.revision}` };
}
export function pointChannel(state: MockState, channel: Channel, release: Release, actorId: string, time: number, verb: string) {
  Object.assign(channel, { releaseId: release.id, status: channel.pausedAt ? "paused" : "active", revision: bump(channel.revision),
    history: [...channel.history, { action: verb, releaseId: release.id, previousReleaseId: channel.releaseId, rollout: channel.rollout, at: iso(time), actorId }] });
  deliveryEvent(state, release.scope, actorId, channel.id, `channel.${verb}`, time);
}

export function reconcileDelivery(state: MockState, wall: number): boolean {
  const initial = !state.delivery, data = deliveryState(state), time = now(state.clock, wall);
  let changed = initial;
  for (const channel of Object.values(data.channels)) if (channel.observations.status === "simulated" && channel.observations.lastReportedAt && time - Date.parse(channel.observations.lastReportedAt) > 300_000) {
    Object.assign(channel, { observations: { ...channel.observations, status: "stale", detail: "Last simulated observation is older than five mock minutes; current delivery is unknown." }, revision: bump(channel.revision) }); changed = true;
  }
  for (const signing of Object.values(data.signing)) {
    if (signing.certificate.expiresAt && signing.certificate.state === "signed" && Date.parse(signing.certificate.expiresAt) <= time) {
      Object.assign(signing, { certificate: { ...signing.certificate, state: "expired" }, revision: bump(signing.revision) }); changed = true;
    }
    for (const key of signing.keys) if (key.state === "overlap" && Date.parse(key.overlapUntil!) <= time) { Object.assign(key, { state: "revoked" }); Object.assign(signing, { revision: bump(signing.revision) }); changed = true; }
  }
  for (const worker of Object.values(data.workers)) if (worker.registration === "pending" && worker.lastHeartbeat && Date.parse(worker.lastHeartbeat) <= time) {
    Object.assign(worker, { registration: "registered", status: "online", lastHeartbeat: iso(time), revision: bump(worker.revision) }); changed = true;
  }
  // Reconcile globally in deadline order, so multiple builds cannot retroactively
  // use the same worker when a tab resumes after a long clock advance.
  for (let scheduled = 0; scheduled < 10_000; scheduled++) {
    const next = Object.entries(data.jobs).filter(([id, job]) => job.deadline <= time && ["queued", "running", "cancel_requested"].includes(state.operations[id].record.state)).sort((a, b) => a[1].deadline - b[1].deadline || a[0].localeCompare(b[0]))[0];
    if (!next) break;
    const [operationId, job] = next;
    for (let singleStep = 0; singleStep < 1; singleStep++) {
      const at = job.deadline;
      if (state.operations[operationId].record.kind === "windows.build") {
        const build = data.builds[job.resourceId];
        if (terminalBuild(build)) break;
        const attempt = build.attempts.at(-1)!;
        if (build.status === "cancel_requested") { finishBuild(state, build, "cancelled", at); changed = true; break; }
        if (build.status === "queued") {
          const worker = Object.values(data.workers).find(w => w.orgId === build.scope.orgId && w.registration === "registered" && w.status === "online" && !w.runningBuildId && build.inputs.formats.every(f => w.formats.includes(f)) && w.toolchains.includes(build.inputs.toolchain));
          const managedBusy = Object.values(data.builds).filter(b => b.inputs.workerPool === "managed" && ["claimed", "running", "cancel_requested"].includes(b.status)).length;
          if (build.inputs.workerPool === "organization" ? !worker : managedBusy >= 2) {
            const activeDeadlines = Object.entries(data.jobs).filter(([id, pending]) => id !== operationId && pending.deadline >= at && state.operations[id].record.kind === "windows.build" && ["claimed", "running", "cancel_requested"].includes(data.builds[pending.resourceId]?.status)).map(([, pending]) => pending.deadline);
            job.deadline = activeDeadlines.length ? Math.max(at + 1000, Math.min(...activeDeadlines)) : time + 1000;
            changed = true; break;
          }
          const occupied = Object.values(data.builds).filter(b => !terminalBuild(b)).map(b => b.attempts.at(-1)?.workerId);
          const workerId = build.inputs.workerPool === "organization" ? worker!.id : ["managed-windows-slot-1", "managed-windows-slot-2"].find(id => !occupied.includes(id))!;
          Object.assign(attempt, { status: "claimed", workerId, leaseId: allocate(state, "lease"), leaseExpiresAt: iso(at + 5000), startedAt: iso(at) });
          Object.assign(build, { status: "claimed", startedAt: build.startedAt ?? iso(at), queueMs: at - Date.parse(build.queuedAt) });
          if (build.inputs.workerPool === "organization") Object.assign(worker!, { runningBuildId: build.id, lastHeartbeat: iso(at), revision: bump(worker!.revision) });
          log(state, build, attempt, "fetch", "Task-scoped lease assigned. Source, artifacts and secret versions are isolated; secret values [REDACTED].", at);
        } else {
          const leaseFailure = job.forcedLeaseExpiryAttempt === attempt.number || job.failure === "lease_exhaustion" || job.failure === "lease_expiry" && attempt.number === 1;
          if (leaseFailure && Date.parse(attempt.leaseExpiresAt!) <= at) {
            Object.assign(attempt, { status: "lease_expired", finishedAt: iso(at), error: "Heartbeat lost; lease expired. Stale lease can no longer finalize." });
            for (const stage of attempt.stages) if (stage.status === "running") Object.assign(stage, { status: "failed", finishedAt: iso(at) });
            meter(state, build, attempt, at); freeWorker(state, build);
            log(state, build, attempt, "fetch", attempt.error!, at, true);
            if (attempt.number < build.inputs.maxAttempts) Object.assign(build, { status: "queued", attempts: [...build.attempts, newAttempt(state, attempt.number + 1)] });
            else { finishBuild(state, build, "failed", at, "Retry policy exhausted after worker lease expiry."); Object.assign(attempt, { status: "lease_expired" }); }
          } else if ((job.failure === "timeout" && at - Date.parse(attempt.startedAt!) >= 4000) || at - Date.parse(attempt.startedAt!) >= build.inputs.timeoutMinutes * 60_000) {
            finishBuild(state, build, "failed", at, "Worker execution timeout; isolated workspace cleaned.");
          } else if (leaseFailure) {
            Object.assign(build, { status: "running" }); Object.assign(attempt, { status: "running" });
          } else {
            Object.assign(build, { status: "running" }); Object.assign(attempt, { status: "running", leaseExpiresAt: iso(at + 5000) });
            const worker = data.workers[attempt.workerId!];
            if (worker) {
              if (worker.registration === "revoked" || worker.status === "offline") { Object.assign(job, { forcedLeaseExpiryAttempt: attempt.number }); Object.assign(attempt, { leaseExpiresAt: iso(at) }); job.deadline += 1000; changed = true; continue; }
              Object.assign(worker, { lastHeartbeat: iso(at) });
            }
            const stage = attempt.stages.find(s => s.status !== "succeeded");
            if (stage) {
              if (stage.status === "pending") { Object.assign(stage, { status: "running", startedAt: iso(at) }); log(state, build, attempt, stage.name, `${stage.name}: started (simulated).`, at); }
              else if (job.failure === "build_failure" && stage.name === "package") finishBuild(state, build, "failed", at, "Simulated Windows packaging failure; no artifacts accepted.");
              else { Object.assign(stage, { status: "succeeded", finishedAt: iso(at) }); log(state, build, attempt, stage.name, `${stage.name}: completed; secret values [REDACTED].`, at); }
            }
            if (attempt.stages.every(s => s.status === "succeeded")) { makeArtifacts(state, build, at); finishBuild(state, build, "succeeded", at); }
          }
        }
        if (!terminalBuild(build)) { Object.assign(build, { revision: bump(build.revision), runMs: build.startedAt ? at - Date.parse(build.startedAt) : 0 }); syncOperation(state, operationId, "running", build.attempts.at(-1)!.stages.filter(s => s.status === "succeeded").length, at); deliveryEvent(state, build.scope, build.actorId, build.id, `build.${build.status}`, at); }
      } else {
        const release = data.releases[job.resourceId], op = state.operations[operationId].record;
        const channel = data.channels[job.channelId!];
        const readiness = releaseReadiness(state, release, at);
        const step = op.state === "queued" ? 0 : op.completedSteps + 1;
        let error = !readiness.allowed ? readiness.checks.filter(c => c.state === "blocked").map(c => c.name).join(", ") : undefined;
        if (job.failure === "publish_failure" && step >= 3) error = "Simulated manifest upload failure before pointer commit; previous channel remains usable.";
        if (step === 4 && channel.revision !== job.expectedChannelRevision) error = "Channel revision conflict. Review its current pointer before retrying publication.";
        if (error) {
          Object.assign(release, { status: "publish_failed", revision: bump(release.revision) }); syncOperation(state, operationId, "failed", op.completedSteps, at, error);
          deliveryEvent(state, release.scope, op.actorId, release.id, "release.publish_failed", at, op.requestId, true); notify(state, release.scope, op.actorId, release.id, "Release publication failed", at, "releases");
        } else if (step === 4) {
          const key = data.signing[release.scope.projectId!].keys.find(k => k.state === "active")!;
          Object.assign(release, { status: "published", publishedAt: iso(at), revision: bump(release.revision), manifest: { digest: digest(JSON.stringify([release.id, release.artifactIds, release.version])), keyId: key.id, signature: "signed", assets: [`${release.id}/version-manifest.fixture.json`, `${channel.id}/availability.fixture.json`] } });
          for (const id of release.artifactIds) Object.assign(data.artifacts[id], { retention: "release_retained", revision: bump(data.artifacts[id].revision) });
          pointChannel(state, channel, release, op.actorId, at, "published"); syncOperation(state, operationId, "succeeded", 4, at);
          deliveryEvent(state, release.scope, op.actorId, release.id, "release.published", at, op.requestId); notify(state, release.scope, op.actorId, release.id, "Release published; delivery not reported", at, "releases");
        } else { syncOperation(state, operationId, "running", step, at); deliveryEvent(state, release.scope, op.actorId, release.id, `release.publish.step.${step}`, at); }
      }
      job.deadline += 1000; changed = true;
    }
  }
  return changed;
}
