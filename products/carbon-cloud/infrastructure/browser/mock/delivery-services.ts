import type { CommandOptions, PageRequest, RequestContext, Result, Scope } from "../../../presentation/framework/services/contracts";
import type { Artifact, Build, BuildInputs, BuildRequest, Channel, DeliveryService, DraftInput, LogRequest, Preflight, Release, Worker } from "../../../presentation/framework/services/delivery-contracts";
import type { CommandReceipt } from "../../../presentation/framework/services/identity-contracts";
import { containsScope, Refusal, requirePermission, requireSession, resolveScope } from "./access";
import { now } from "./clock";
import { configurationState } from "./configuration-state";
import { allocate, bump } from "./identity-state";
import { paginate } from "./pagination";
import { action, deliveryState, digest, terminalBuild } from "./delivery-state";
import { artifactBytes, cancelQueuedBuild, createBuild, deliveryEvent, iso, operation, pointChannel, releaseReadiness } from "./delivery-engine";
import type { MockState } from "./store";
import { operationsState } from "./operations-state";

type Run = <T>(execute: (state: MockState, requestId: string) => T, config?: { signal?: AbortSignal; mutate?: boolean; fast?: boolean; audit?: { scope: Scope; action: string; resourceId?: string } }) => Promise<Result<T>>;
const revision = (value: string, options: CommandOptions) => { if (value !== options.expectedRevision) throw new Refusal("conflict", "Resource changed. Reload and compare its current revision before submitting."); };
const required = (value: string, name: string, max = 2000) => { if (!value?.trim() || value.length > max) throw new Refusal("validation", `${name} must contain 1-${max} characters.`); return value.trim(); };
const formats = (values: readonly string[]) => { if (!values.length || values.length > 2 || new Set(values).size !== values.length || values.some(f => !["nsis", "wix"].includes(f))) throw new Refusal("validation", "Select NSIS and/or WiX once each."); };
const validVersion = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/.test(value);
function once<T>(state: MockState, scope: Scope, name: string, input: unknown, options: CommandOptions, execute: () => T): T {
  required(options.idempotencyKey, "Idempotency key", 200);
  const key = JSON.stringify([state.sessions[state.activeSessionId!].accountId, scope, name, options.idempotencyKey]);
  const fingerprint = JSON.stringify([input, options.expectedRevision]);
  const prior = state.idempotency[key];
  if (prior) { if (prior.fingerprint !== fingerprint) throw new Refusal("conflict", "Idempotency key already used with different input."); return structuredClone(prior.value) as T; }
  const result = execute();
  const stored = structuredClone(result) as T & { secretValue?: string };
  delete stored.secretValue;
  state.idempotency[key] = { fingerprint, value: stored };
  return result;
}
export function createDeliveryServices(run: Run, wallTime: () => number, subscribeChanges: (listener: () => void) => () => void): DeliveryService {
  const clock = (state: MockState) => now(state.clock, wallTime());
  const actor = (state: MockState) => requireSession(state, wallTime()).accountId;
  const read = (state: MockState, scope: Scope, project = true) => {
    const resolved = requirePermission(state, scope, "metadata.read", wallTime());
    if (project && (!resolved.project || scope.environmentId)) throw new Refusal("validation", "Select a project route, not an environment route.");
    return resolved;
  };
  const page = <T extends { id: string; name?: string }>(state: MockState, scope: Scope, items: T[], request?: PageRequest, extra = "") => paginate(items, request, `${requireSession(state, wallTime()).visibilityKey}:${JSON.stringify(scope)}:${extra}`);
  const ownBuild = (state: MockState, context: RequestContext, id: string) => {
    read(state, context.scope, false); const build = deliveryState(state).builds[id];
    if (!build || !containsScope(context.scope, build.scope)) throw new Refusal("not_found", "Build not found.");
    requirePermission(state, build.scope, "metadata.read", wallTime()); return build;
  };
  const ownRelease = (state: MockState, scope: Scope, id: string) => {
    read(state, scope, false); const release = deliveryState(state).releases[id];
    if (!release || !containsScope(scope, release.scope)) throw new Refusal("not_found", "Release not found.");
    requirePermission(state, release.scope, "metadata.read", wallTime()); return release;
  };
  const ownChannel = (state: MockState, scope: Scope, id: string) => { read(state, scope); const channel = deliveryState(state).channels[id]; if (!channel || channel.projectId !== scope.projectId) throw new Refusal("not_found", "Channel not found."); return channel; };
  const configure = (state: MockState, scope: Scope) => requirePermission(state, scope, "resources.configure", wallTime());
  const production = (state: MockState, scope: Scope, confirmation?: string, stable = false, permission: "resources.configure" | "release.publish" = "release.publish") => {
    const env = state.environments[scope.environmentId!];
    if (stable || env?.kind === "production") {
      requirePermission(state, scope, permission, wallTime());
      if ((stable || env?.requireProductionConfirmation !== false) && confirmation !== scope.environmentId) throw new Refusal("validation", `Type environment ID ${scope.environmentId} to confirm this production/stable action.`);
    }
  };
  const canCancel = (state: MockState, build: Build) => { const p = resolveScope(state, build.scope, wallTime()).permissions; return p["resources.configure"].allowed && (build.actorId === actor(state) || p["build.cancel.any"].allowed); };
  const buildDto = (state: MockState, build: Build): Build => ({ ...build, actions: { cancel: action(canCancel(state, build) && !terminalBuild(build) && build.status !== "cancel_requested", "Only the build author or a member with cancel-other-build permission can cancel active work."), retry: action(["failed", "cancelled"].includes(build.status) && resolveScope(state, build.scope, wallTime()).permissions["resources.configure"].allowed, "Retry requires failed/cancelled work and permission for its original environment."), draft: action(build.status === "succeeded" && resolveScope(state, build.scope, wallTime()).permissions["resources.configure"].allowed, "A successful build and configuration permission are required.") } });
  const artifactDto = (state: MockState, artifact: Artifact): Artifact => {
    const retained = !artifact.deletedAt && (artifact.retention === "release_retained" || Date.parse(artifact.expiresAt) > clock(state));
    const releaseIds = Object.values(deliveryState(state).releases).filter(r => r.artifactIds.includes(artifact.id)).map(r => r.id);
    return { ...artifact, releaseIds, actions: { download: action(retained, "Artifact was removed or its fixture retention expired."), remove: action(!artifact.deletedAt && !releaseIds.length && resolveScope(state, artifact.scope, wallTime()).permissions["organization.manage"].allowed, releaseIds.length ? `Retained by releases: ${releaseIds.join(", ")}. Remove drafts or review withdrawal; published history still retains its assets.` : "Organization administration is required; logs and build metadata are retained.") } };
  };
  const releaseDto = (state: MockState, release: Release): Release => {
    const p = resolveScope(state, release.scope, wallTime()).permissions;
    return { ...release, actions: { edit: action(["draft", "publish_failed"].includes(release.status) && p["resources.configure"].allowed, "Only draft or failed-publication metadata can be edited."), publish: action(["draft", "publish_failed"].includes(release.status) && p["release.publish"].allowed, "Publication requires a release grant and a draft/failed publication."), remove: action(["draft", "publish_failed"].includes(release.status) && p["resources.configure"].allowed, "Published or publishing records cannot be deleted."), withdraw: action(release.status === "published" && p["release.publish"].allowed, "Only published releases can be withdrawn by a release manager.") } };
  };
  const channelDto = (state: MockState, scope: Scope, channel: Channel): Channel => {
    const release = channel.releaseId ? deliveryState(state).releases[channel.releaseId] : undefined;
    const permitted = resolveScope(state, release?.scope ?? scope, wallTime()).permissions["release.publish"].allowed;
    const protocol = !release || release.compatibility === "carbon-polling-v1";
    return { ...channel, observations: { ...channel.observations, eligible: channel.observations.population === null ? null : Math.floor(channel.observations.population * channel.rollout / 100) }, actions: { update: action(permitted, "Release publishing permission is required for the intended environment."), pause: action(permitted && protocol && channel.status === "active", "An active polling-v1 channel is required."), resume: action(permitted && protocol && channel.status === "paused" && release?.status === "published", "A paused channel with a non-withdrawn published release is required."), rollback: action(permitted && channel.history.some(h => h.previousReleaseId), "No previous pointer is available, or permission is missing.") } };
  };
  const capacity = (state: MockState, scope: Scope) => {
    const data = deliveryState(state), builds = Object.values(data.builds), local = builds.filter(b => b.scope.orgId === scope.orgId);
    return { managedAvailable: data.scenario === "no_capacity" ? 0 : Math.max(0, 2 - builds.filter(b => b.inputs.workerPool === "managed" && ["claimed", "running", "cancel_requested"].includes(b.status)).length),
      organizationAvailable: Object.values(data.workers).filter(w => w.orgId === scope.orgId && w.registration === "registered" && w.status === "online" && !w.runningBuildId).length,
      queued: local.filter(b => b.status === "queued").length, usedMinutes: Object.values(data.usage).filter(u => u.orgId === scope.orgId).reduce((n, u) => n + u.minutes, 0),
      reservedMinutes: local.filter(b => !terminalBuild(b)).reduce((n, b) => n + b.inputs.timeoutMinutes * b.inputs.maxAttempts, 0), limitMinutes: data.scenario === "quota" ? 0 : 500 };
  };
  const preflight = (state: MockState, scope: Scope, input: BuildRequest, original?: BuildInputs): Preflight => {
    read(state, scope); formats(input.formats);
    const envScope = { ...scope, environmentId: input.environmentId }, resolved = requirePermission(state, envScope, "metadata.read", wallTime());
    const data = deliveryState(state), config = configurationState(state), repository = config.repositories[scope.projectId!];
    const settings = original ? { ...data.settings[scope.projectId!], ...original, revision: original.configurationRevision } : data.settings[scope.projectId!];
    const historical = original ?? Object.values(data.builds).find(b => b.scope.projectId === scope.projectId && b.inputs.commit === input.ref)?.inputs;
    const sourceRepository = historical?.repository ?? repository.repository;
    const installation = Object.values(config.installations).find(i => i.orgId === scope.orgId && i.status === "connected" && i.repositories.includes(sourceRepository ?? "") && i.scopes.includes("contents:read"));
    const signing = structuredClone(original?.signing ?? data.signing[scope.projectId!]), cap = capacity(state, scope);
    if (["signing_invalid", "signing_unknown", "signing_expired"].includes(data.scenario)) Object.assign(signing.certificate, { state: data.scenario.slice(8) });
    const checks: { name: string; state: "pass" | "warning" | "blocked"; detail: string }[] = [];
    const check = (name: string, pass: boolean, detail: string, warning = false) => checks.push({ name, state: pass ? "pass" : warning ? "warning" : "blocked", detail });
    check("Environment permission", resolved.permissions["resources.configure"].allowed, resolved.permissions["resources.configure"].reason ?? "Build permission granted for this environment.");
    check("Ready environment", resolved.environment?.status === "ready" && resolved.project?.status !== "archived", "Build requires a ready environment and an active project.");
    check("Repository access", !!installation, "Connected installation must include the selected immutable source repository and contents:read scope.");
    check("Manifest/configuration", !!historical || repository.manifest.status === "ready" && repository.proposal.status === "applied" && settings.configurationStatus === "synchronized", "Resolve manifest conflicts and apply repository proposals first. Cloud overrides do not edit the source manifest.");
    const activeCommit = digest(`${repository.repository}:${repository.revision}:${settings.manifest.digest}:${repository.branch}`).split(":")[1].slice(0, 40);
    const refValid = input.ref === repository.branch || input.ref === activeCommit || !!historical;
    check("Immutable source", refValid && data.scenario !== "stale_ref", `Choose current branch ${repository.branch} or a 40-character commit. Stale refs must be refreshed.`);
    check("Worker capacity", data.scenario !== "no_capacity" && (settings.workerPool === "managed" || Object.values(data.workers).some(w => w.orgId === scope.orgId && w.registration === "registered" && w.status === "online" && input.formats.every(f => w.formats.includes(f)) && w.toolchains.includes(settings.toolchain))), settings.workerPool === "managed" ? `${cap.managedAvailable} managed slots available; busy slots queue the build.` : "An online organization worker must support the selected formats and toolchain.");
    check("Build quota", cap.usedMinutes + cap.reservedMinutes + settings.timeoutMinutes * settings.maxAttempts <= cap.limitMinutes, `${cap.usedMinutes} used + ${cap.reservedMinutes} reserved / ${cap.limitMinutes} mock minutes. Each request reserves its maximum attempts.`);
    check("Signing readiness", signing.certificate.state === "signed", `Windows certificate: ${signing.certificate.state}. Unsigned builds may exist; production publication applies signing policy.`, true);
    const plugins = historical?.plugins ?? data.plugins[scope.projectId!];
    check("Dependency lock", !["plugin_revoked", "plugin_incompatible"].includes(data.scenario) && plugins.every(p => p.trust === "verified" && p.compatible), "Pinned dependencies must be compatible and not revoked. No dependency management is implemented before Slice 8.");
    const commit = /^[a-f0-9]{40}$/.test(input.ref) ? input.ref : activeCommit;
    const secretRefs = Object.values(config.secrets).filter(s => s.scope.environmentId === input.environmentId).map(s => ({ id: s.id, version: s.version }));
    // Project signing binding may point to a dedicated environment; snapshot only its version, never its value.
    if (signing.certificate.secretId) { const secret = config.secrets[signing.certificate.secretId]; if (secret && !secretRefs.some(s => s.id === secret.id)) secretRefs.push({ id: secret.id, version: secret.version }); if (secret) Object.assign(signing.certificate, { secretVersion: secret.version }); }
    const inputs: BuildInputs = { repository: historical?.repository ?? repository.repository ?? "", branch: historical?.branch ?? repository.branch, commit, rootDirectory: historical?.rootDirectory ?? repository.rootDirectory, repositoryRevision: historical?.repositoryRevision ?? repository.revision, manifest: historical?.manifest ?? settings.manifest, configurationRevision: settings.revision,
      toolchain: settings.toolchain, targetTriple: "x86_64-pc-windows-msvc", formats: input.formats, profile: settings.profile, environmentId: input.environmentId, secretRefs, signing, plugins: structuredClone(plugins), dependencyRevision: digest(JSON.stringify(plugins)), cacheGeneration: settings.cacheGeneration, cacheBypassed: settings.invalidateNext,
      workerPool: settings.workerPool, timeoutMinutes: settings.timeoutMinutes, maxAttempts: settings.maxAttempts };
    return { allowed: checks.every(c => c.state !== "blocked"), checks, inputs, revision: `${settings.revision}:${repository.revision}:${signing.revision}:${resolved.environment!.revision}` };
  };
  const assertPreflight = (result: Preflight) => { if (!result.allowed) throw new Refusal(result.checks.some(c => c.name === "Build quota" && c.state === "blocked") ? "quota_exceeded" : "validation", result.checks.filter(c => c.state === "blocked").map(c => `${c.name}: ${c.detail}`).join("\n")); };
  const command = async (context: RequestContext, name: string, options: CommandOptions, input: unknown, execute: (state: MockState, requestId: string) => CommandReceipt): Promise<Result<CommandReceipt>> => {
    let lostResponse = false;
    const result = await run((state, requestId) => {
      read(state, context.scope, false);
      // Reauthorize even an idempotent replay, before returning its original receipt.
      const payload = input as { id?: string; releaseId?: string; channelId?: string; input?: { buildId?: string; environmentId?: string } };
      let target = context.scope;
      if (payload.releaseId && !(name === "release.delete" && !deliveryState(state).releases[payload.releaseId])) target = ownRelease(state, context.scope, payload.releaseId).scope;
      if (payload.input?.buildId) target = ownBuild(state, context, payload.input.buildId).scope;
      if (payload.input?.environmentId) target = { ...context.scope, environmentId: payload.input.environmentId };
      if (name.startsWith("build.") && payload.id) target = ownBuild(state, context, payload.id).scope;
      if (payload.channelId) { const channel = ownChannel(state, context.scope, payload.channelId); if (!payload.releaseId && channel.releaseId) target = ownRelease(state, context.scope, channel.releaseId).scope; }
      if (name.startsWith("worker.") || name === "build.cache.invalidate" || name === "artifact.remove") requirePermission(state, target, "organization.manage", wallTime());
      else if (name.startsWith("signing.")) requirePermission(state, target, "signing.manage", wallTime());
      else if (name.startsWith("channel.") || name === "release.publish" || name === "release.withdraw") requirePermission(state, target, "release.publish", wallTime());
      else configure(state, target);
      if (name === "build.cancel" && !canCancel(state, ownBuild(state, context, payload.id!))) throw new Refusal("forbidden", "Cancelling another actor's build requires a separate scoped grant.");
      return once(state, context.scope, name, input, options, () => {
        const receipt = execute(state, requestId);
        if (deliveryState(state).scenario === "lost_response" && ["build.start", "build.provider", "release.publish"].includes(name)) { lostResponse = true; deliveryState(state).scenario = "success"; }
        return receipt;
      });
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: `${name}.refused` } });
    return result.ok && lostResponse ? { ok: false, error: { code: "unavailable", message: "Command committed but its response was lost. Submit again with the same unchanged form to recover its idempotency receipt, or open resource history. Do not assume it failed.", requestId: "mock:delivery:lost-response" } } : result;
  };
  const mark = (state: MockState, scope: Scope, resourceId: string, verb: string, requestId: string) => deliveryEvent(state, scope, actor(state), resourceId, verb, clock(state), requestId);
  const start = (context: RequestContext, input: BuildRequest, options: CommandOptions, provider?: { deliveryId: string; event: "push" | "pull_request" }) => command(context, provider ? "build.provider" : "build.start", options, { input, provider }, (state, requestId) => {
    read(state, context.scope); const data = deliveryState(state), repo = configurationState(state).repositories[context.scope.projectId!];
    const billing = operationsState(state), subscription = billing.subscriptions[context.scope.orgId];
    const usedMinutes = Object.values(billing.usage).filter(item => item.orgId === context.scope.orgId && item.kind === "build_minutes" && item.classification !== "unavailable").reduce((sum, item) => sum + Number(item.quantity), 0);
    const budget = Object.values(billing.budgets).find(item => item.orgId === context.scope.orgId && item.kind === "build_minutes");
    if (usedMinutes >= subscription.entitlements.buildMinutes || budget?.state === "blocked") throw new Refusal("quota_exceeded", "Build-minute hard cap reached. Upgrade, raise the cap, or reduce future charged work; existing artifacts remain available.");
    const envScope = { ...context.scope, environmentId: input.environmentId };
    configure(state, envScope); production(state, envScope, input.confirmation, false, "resources.configure");
    if (provider) {
      required(provider.deliveryId, "Provider delivery ID", 100);
      if (!(provider.event === "push" ? repo.pushTrigger : repo.pullRequestTrigger) || input.ref !== repo.branch) throw new Refusal("validation", "This event or branch is not enabled in repository triggers.");
      const prior = data.providerEvents[`${context.scope.projectId}:${provider.deliveryId}`];
      if (prior) { if (prior.fingerprint !== JSON.stringify([input, provider.event])) throw new Refusal("conflict", "Provider delivery identity was reused with different input."); return { message: "Duplicate provider delivery; existing build retained.", resourceId: prior.buildId, operationId: data.builds[prior.buildId].operationId }; }
    }
    const result = preflight(state, context.scope, input); assertPreflight(result); revision(result.revision, options);
    const build = createBuild(state, envScope, actor(state), result.inputs!, clock(state), requestId, provider?.event ?? "manual", data.scenario, undefined, provider?.deliveryId);
    if (provider) data.providerEvents[`${context.scope.projectId}:${provider.deliveryId}`] = { fingerprint: JSON.stringify([input, provider.event]), buildId: build.id };
    const settings = data.settings[context.scope.projectId!]; if (settings.invalidateNext) Object.assign(settings, { invalidateNext: false, revision: bump(settings.revision) });
    return { message: "Windows build queued. Its immutable inputs and operation are retained across navigation and reload.", resourceId: build.id, operationId: build.operationId };
  });
  const workerDto = (state: MockState, worker: Worker): Worker => {
    const admin = resolveScope(state, { orgId: worker.orgId }, wallTime()).permissions["organization.manage"].allowed;
    return { ...worker, actions: { rotate: action(admin && worker.registration !== "revoked"), revoke: action(admin && worker.registration !== "revoked"), pause: action(admin && worker.status === "online"), drain: action(admin && ["online", "paused"].includes(worker.status)), resume: action(admin && worker.registration === "registered" && worker.status !== "online"), remove: action(admin && worker.status === "offline" && !worker.runningBuildId, "Only offline workers without an active task can be removed.") } };
  };
  const validateDraft = (state: MockState, scope: Scope, input: DraftInput, existingId?: string) => {
    const build = ownBuild(state, { scope }, input.buildId); configure(state, build.scope);
    if (build.status !== "succeeded") throw new Refusal("validation", "A successful immutable build is required.");
    if (!validVersion(input.version) || input.version !== build.inputs.manifest.version) throw new Refusal("validation", `Version must match binary manifest ${build.inputs.manifest.version}. Update source metadata and rebuild to use another version.`);
    if (Object.values(deliveryState(state).releases).some(r => r.id !== existingId && r.scope.projectId === scope.projectId && r.version === input.version)) throw new Refusal("conflict", "Release version already exists, including withdrawn history.");
    if (!input.artifactIds.length || new Set(input.artifactIds).size !== input.artifactIds.length || input.artifactIds.some(id => !build.artifactIds.includes(id) || deliveryState(state).artifacts[id].deletedAt)) throw new Refusal("validation", "Choose retained artifacts from this build.");
    if (!["carbon-polling-v1", "installer-only"].includes(input.compatibility) || !["compatible", "forward_only", "unknown"].includes(input.migration) || input.notes.length > 4000) throw new Refusal("validation", "Unsupported compatibility, migration declaration or notes length.");
    ownChannel(state, scope, input.channelId); return build;
  };
  const service: DeliveryService = {
    getBuildSettings: context => run(state => { read(state, context.scope); return deliveryState(state).settings[context.scope.projectId!]; }, { signal: context.signal }),
    saveBuildSettings: (context, input, options) => command(context, "build.settings", options, input, (state, requestId) => {
      read(state, context.scope); configure(state, context.scope); const settings = deliveryState(state).settings[context.scope.projectId!]; revision(settings.revision, options); formats(input.formats);
      if (!["debug", "release"].includes(input.profile) || input.toolchain !== "carbon-windows-1.0" || !["managed", "organization"].includes(input.workerPool) || !Number.isInteger(input.timeoutMinutes) || input.timeoutMinutes < 1 || input.timeoutMinutes > 60 || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3) throw new Refusal("validation", "Use the supported Windows toolchain, a 1–60 minute timeout, and 1–3 attempts.");
      Object.assign(settings, { ...input, revision: bump(settings.revision) }); mark(state, context.scope, settings.projectId, "build.settings.updated", requestId); return { message: "Versioned Cloud build overrides saved. Repository manifest is unchanged." };
    }),
    invalidateCache: (context, options) => command(context, "build.cache.invalidate", options, {}, (state, requestId) => {
      requirePermission(state, context.scope, "organization.manage", wallTime()); read(state, context.scope); const settings = deliveryState(state).settings[context.scope.projectId!]; revision(settings.revision, options);
      Object.assign(settings, { cacheGeneration: settings.cacheGeneration + 1, invalidateNext: true, revision: bump(settings.revision) }); mark(state, context.scope, settings.projectId, "build.cache.invalidated", requestId); return { message: "The next new build will bypass this project's cache. Historical artifacts and provenance are retained." };
    }),
    getBuildPreflight: (context, input) => run(state => preflight(state, context.scope, input), { signal: context.signal }),
    startBuild: (context, input, options) => start(context, input, options),
    simulateRepositoryEvent: (context, input, options) => { const { deliveryId, event, ...request } = input; return start(context, request, options, { deliveryId, event }); },
    listBuilds: (context, filter) => run(state => {
      read(state, context.scope); const items = Object.values(deliveryState(state).builds).filter(b => b.scope.projectId === context.scope.projectId && (!filter?.status || b.status === filter.status) && (!filter?.branch || b.inputs.branch.includes(filter.branch)) && (!filter?.actorId || b.actorId === filter.actorId) && (!filter?.format || b.inputs.formats.includes(filter.format as "nsis")) && (!filter?.environmentId || b.scope.environmentId === filter.environmentId) && (!filter?.after || b.queuedAt >= filter.after) && (!filter?.before || b.queuedAt.slice(0, 10) <= filter.before)).map(b => buildDto(state, b));
      const { cursor: _, ...bound } = filter ?? {}; return page(state, context.scope, items, filter, JSON.stringify(bound));
    }, { signal: context.signal }),
    getBuild: (context, id) => run(state => buildDto(state, ownBuild(state, context, id)), { signal: context.signal }),
    cancelBuild: (context, id, options) => command(context, "build.cancel", options, { id }, (state, requestId) => {
      const build = ownBuild(state, context, id); if (!canCancel(state, build)) throw new Refusal("forbidden", "Cancelling another actor's build requires a separate scoped grant."); revision(build.revision, options);
      if (terminalBuild(build)) throw new Refusal("conflict", `Authoritative build state is ${build.status}; completion may have won the cancellation race.`);
      if (build.status === "queued") cancelQueuedBuild(state, build, clock(state));
      else { Object.assign(build, { status: "cancel_requested", revision: bump(build.revision) }); const op = state.operations[build.operationId]; Object.assign(op.record, { state: "cancel_requested", revision: bump(op.record.revision) }); }
      mark(state, build.scope, id, "build.cancel_requested", requestId); return { message: build.status === "cancelled" ? "Queued build cancelled immediately." : "Cancellation requested; waiting for worker acknowledgement.", resourceId: id, operationId: build.operationId };
    }),
    retryBuild: (context, id, latest, confirmation, options) => command(context, "build.retry", options, { id, latest, confirmation }, (state, requestId) => {
      const build = ownBuild(state, context, id); configure(state, build.scope); production(state, build.scope, confirmation, false, "resources.configure"); revision(build.revision, options);
      if (!["failed", "cancelled"].includes(build.status)) throw new Refusal("conflict", "Only failed or cancelled builds can be retried.");
      const data = deliveryState(state), check = preflight(state, { orgId: build.scope.orgId, projectId: build.scope.projectId }, { environmentId: build.scope.environmentId!, ref: latest ? configurationState(state).repositories[build.scope.projectId!].branch : build.inputs.commit, formats: build.inputs.formats }, latest ? undefined : build.inputs);
      assertPreflight(check);
      if (!latest && build.inputs.plugins.some(p => data.plugins[build.scope.projectId!].some(current => current.id === p.id && current.trust === "revoked"))) throw new Refusal("validation", "The original dependency lock now contains a revoked package.");
      const next = createBuild(state, build.scope, actor(state), latest ? check.inputs! : build.inputs, clock(state), requestId, "retry", data.scenario, id);
      if (latest && data.settings[build.scope.projectId!].invalidateNext) Object.assign(data.settings[build.scope.projectId!], { invalidateNext: false, revision: bump(data.settings[build.scope.projectId!].revision) });
      return { message: latest ? "Retry queued with explicitly refreshed source and configuration." : "Retry queued with the original immutable inputs and a link to the previous build.", resourceId: next.id, operationId: next.operationId };
    }),
    readLogs: (context, id, request = {}) => run(state => {
      ownBuild(state, context, id); const logs = deliveryState(state).logs[id];
      const cursor = request.cursor ? Number(request.cursor) : 0, limit = request.limit ?? 100;
      if (!Number.isInteger(cursor) || cursor < 0 || cursor > logs.length || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Refusal("validation", "Invalid log cursor or page size; reconnect from the beginning.");
      const matches = logs.filter(l => l.sequence > cursor && (!request.stage || l.stage === request.stage) && (!request.stream || l.stream === request.stream) && (!request.search || l.text.toLowerCase().includes(request.search.toLowerCase())));
      const items = matches.slice(0, limit); return { items, cursor: String(matches.length > limit ? items.at(-1)!.sequence : logs.length), hasMore: matches.length > limit };
    }, { signal: context.signal }),
    subscribeLogs: async (context, id, request, listener) => {
      const session = await run(state => requireSession(state, wallTime()).visibilityKey, { signal: context.signal }); if (!session.ok) return session;
      let cursor = request.cursor, closed = false, queue = Promise.resolve();
      const pump = () => { queue = queue.then(async () => {
        if (closed) return;
        const current = await run(state => requireSession(state, wallTime()).visibilityKey, { fast: true });
        if (!current.ok || current.value !== session.value) { stop(); listener({ ok: false, error: { code: "unauthenticated", message: "Log subscription authorization changed.", requestId: "mock:logs" } }); return; }
        const result = await service.readLogs(context, id, { ...request, cursor }); if (closed) return;
        if (result.ok) cursor = result.value.cursor; else stop(); listener(result);
      }); };
      const unsubscribe = subscribeChanges(pump);
      const stop = () => { closed = true; unsubscribe(); context.signal?.removeEventListener("abort", stop); };
      context.signal?.addEventListener("abort", stop, { once: true });
      if (context.signal?.aborted) stop(); else pump();
      return { ok: true, value: stop };
    },
    exportLogs: (context, id) => run((state, requestId) => {
      const build = ownBuild(state, context, id); mark(state, build.scope, id, "build.logs.exported", requestId);
      return { filename: `${id}.redacted.log.txt`, contentType: "text/plain", bytes: [...new TextEncoder().encode(deliveryState(state).logs[id].map(l => `${l.sequence} ${l.occurredAt} ${l.attemptId} ${l.stage} ${l.stream}: ${l.text}`).join("\n"))] };
    }, { signal: context.signal, mutate: true }),
    listArtifacts: (context, buildId, request) => run(state => { const build = ownBuild(state, context, buildId); return page(state, build.scope, build.artifactIds.map(id => artifactDto(state, deliveryState(state).artifacts[id])), request, buildId); }, { signal: context.signal }),
    downloadArtifact: (context, id) => run((state, requestId) => {
      read(state, context.scope, false); const item = deliveryState(state).artifacts[id]; if (!item || !containsScope(context.scope, item.scope)) throw new Refusal("not_found", "Artifact not found."); ownBuild(state, context, item.buildId);
      const permitted = artifactDto(state, item).actions.download; if (!permitted.allowed) throw new Refusal("conflict", permitted.reason!);
      mark(state, item.scope, id, "artifact.downloaded", requestId); return { filename: item.name, contentType: "text/plain", bytes: [...artifactBytes(item.buildId, id, item.name)] };
    }, { signal: context.signal, mutate: true, audit: { scope: context.scope, action: "artifact.download.refused" } }),
    removeArtifact: (context, id, confirmation, options) => command(context, "artifact.remove", options, { id, confirmation }, (state, requestId) => {
      const item = deliveryState(state).artifacts[id]; if (!item || !containsScope(context.scope, item.scope)) throw new Refusal("not_found", "Artifact not found."); ownBuild(state, context, item.buildId); revision(item.revision, options);
      const permitted = artifactDto(state, item).actions.remove; if (!permitted.allowed) throw new Refusal("conflict", permitted.reason!); if (confirmation !== id) throw new Refusal("validation", `Type ${id} to remove this fixture payload; metadata and logs remain.`);
      Object.assign(item, { deletedAt: iso(clock(state)), revision: bump(item.revision) }); mark(state, item.scope, id, "artifact.removed", requestId); return { message: "Fixture payload removed; artifact tombstone, build provenance and redacted logs retained." };
    }),
    getCapacity: context => run(state => { read(state, context.scope, false); return capacity(state, context.scope); }, { signal: context.signal }),
    listWorkers: (context, request) => run(state => { read(state, context.scope, false); return page(state, { orgId: context.scope.orgId }, Object.values(deliveryState(state).workers).filter(w => w.orgId === context.scope.orgId).map(w => workerDto(state, w)), request); }, { signal: context.signal }),
    workerCommand: (context, input, options) => command(context, `worker.${input.kind}`, options, input, (state, requestId) => {
      requirePermission(state, { orgId: context.scope.orgId }, "organization.manage", wallTime()); const data = deliveryState(state); let id: string; let secretValue: string | undefined;
      if (input.kind === "enroll") {
        formats(input.formats); id = allocate(state, "worker"); const prefix = `cc_worker_${id}`; secretValue = `${prefix}.FAKE-ONE-TIME-${crypto.randomUUID()}`;
        data.workers[id] = { id, orgId: context.scope.orgId, name: required(input.name, "Worker name", 100), revision: "r1", registration: "pending", status: "offline", formats: input.formats, toolchains: ["carbon-windows-1.0"], lastHeartbeat: iso(clock(state) + 1000), capacity: 1, credentialPrefix: prefix, actions: {} as Worker["actions"] };
      } else {
        id = input.workerId; const item = data.workers[id]; if (!item || item.orgId !== context.scope.orgId) throw new Refusal("not_found", "Worker not found."); revision(item.revision, options);
        const permitted = workerDto(state, item).actions[input.kind]; if (!permitted.allowed) throw new Refusal("conflict", permitted.reason!);
        if (["revoke", "remove"].includes(input.kind) && input.confirmation !== id) throw new Refusal("validation", `Type ${id}; revocation stops worker credentials and its active lease may expire.`);
        if (input.kind === "remove") delete data.workers[id];
        else if (input.kind === "rotate") { const prefix = `cc_worker_${allocate(state, "credential")}`; Object.assign(item, { credentialPrefix: prefix, revision: bump(item.revision) }); secretValue = `${prefix}.FAKE-ONE-TIME-${crypto.randomUUID()}`; }
        else Object.assign(item, { status: input.kind === "pause" ? "paused" : input.kind === "drain" ? item.runningBuildId ? "draining" : "offline" : input.kind === "resume" ? "online" : "offline", registration: input.kind === "revoke" ? "revoked" : item.registration, revision: bump(item.revision), lastHeartbeat: iso(clock(state)) });
      }
      mark(state, { orgId: context.scope.orgId }, id, `worker.${input.kind}`, requestId); return { message: input.kind === "enroll" ? "Worker enrolled; simulated registration completes on the next clock tick. Copy the one-time fake enrollment credential." : `Worker ${input.kind} applied.`, resourceId: id, secretValue };
    }),
    getSigning: context => run(state => { const resolved = read(state, context.scope); const data = deliveryState(state), item = data.signing[context.scope.projectId!]; return { ...item, keys: item.keys.map(k => ({ ...k, affectedReleaseIds: Object.values(data.releases).filter(r => r.scope.projectId === context.scope.projectId && (r.manifest?.keyId === k.id || r.artifactIds.some(id => data.artifacts[id]?.keyId === k.id))).map(r => r.id) })), actions: { configure: resolved.permissions["signing.manage"], rotate: resolved.permissions["signing.manage"] } }; }, { signal: context.signal }),
    signingCommand: (context, input, options) => command(context, `signing.${input.kind}`, options, input, (state, requestId) => {
      read(state, context.scope); requirePermission(state, context.scope, "signing.manage", wallTime()); const data = deliveryState(state), item = data.signing[context.scope.projectId!]; revision(item.revision, options);
      const config = configurationState(state), binding = `Windows signing:${context.scope.projectId}`;
      if (input.kind === "certificate" || input.kind === "disable-certificate") {
        if (input.kind === "certificate") { const secret = config.secrets[input.secretId]; if (!secret || secret.scope.projectId !== context.scope.projectId || secret.type !== "signing") throw new Refusal("validation", "Select a signing secret reference in this project.");
          if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= clock(state)) throw new Refusal("validation", "Certificate expiry must be a future ISO date.");
          Object.assign(item, { certificate: { state: "signed", subject: required(input.subject, "Public certificate subject", 200), expiresAt: iso(Date.parse(input.expiresAt)), secretId: secret.id, secretVersion: secret.version } });
        } else Object.assign(item, { certificate: { state: "not_configured" } });
        for (const secret of Object.values(config.secrets)) { const bindings = secret.bindings.filter(b => b !== binding); if (secret.id === item.certificate.secretId) bindings.push(binding); if (JSON.stringify(bindings) !== JSON.stringify(secret.bindings)) Object.assign(secret, { bindings, revision: bump(secret.revision) }); }
      } else if (input.kind === "rotate-key") {
        if (input.clientCompatibility !== "carbon-polling-v1") throw new Refusal("unsupported_operation", "Only the simulated polling-v1 cross-signing transition supports key overlap. Existing runtime interoperability remains unverified.");
        if (!Number.isInteger(input.overlapDays) || input.overlapDays < 1 || input.overlapDays > 90) throw new Refusal("validation", "Overlap must be 1–90 days.");
        const previous = item.keys.find(k => k.state === "active"), id = allocate(state, "update_key");
        Object.assign(item, { keys: [...item.keys.map(k => k.state === "active" ? { ...k, state: "overlap", overlapUntil: iso(clock(state) + input.overlapDays * 86_400_000) } : k), { id, publicKey: `MOCK-PUBLIC-${id}`, state: "active", createdAt: iso(clock(state)), crossSignedBy: previous?.id }] });
      } else { const key = item.keys.find(k => k.id === input.keyId); if (!key) throw new Refusal("not_found", "Update key not found.");
        if (input.confirmation !== key.id) throw new Refusal("validation", `Type ${key.id} to revoke trust. Previously published history remains; review affected channels.`);
        if (key.state === "active") throw new Refusal("conflict", "Rotate to a new active key before revoking this reference."); Object.assign(key, { state: "revoked" }); }
      Object.assign(item, { revision: bump(item.revision) }); mark(state, context.scope, context.scope.projectId!, `signing.${input.kind}`, requestId); return { message: "Signing metadata updated. Historical artifacts are unchanged; private key material is never returned." };
    }),
    listReleases: (context, request) => run(state => { read(state, context.scope); return page(state, context.scope, Object.values(deliveryState(state).releases).filter(r => r.scope.projectId === context.scope.projectId).map(r => ({ ...releaseDto(state, r), name: r.version })), request); }, { signal: context.signal }),
    getRelease: (context, id) => run(state => releaseDto(state, ownRelease(state, context.scope, id)), { signal: context.signal }),
    getReleasePreflight: (context, id) => run(state => { const release = ownRelease(state, context.scope, id), result = releaseReadiness(state, release, clock(state)); const permission = resolveScope(state, release.scope, wallTime()).permissions["release.publish"]; return { ...result, allowed: result.allowed && permission.allowed, checks: [...result.checks, { name: "Publication permission", state: permission.allowed ? "pass" : "blocked", detail: permission.reason ?? "Release permission granted." }] }; }, { signal: context.signal }),
    releaseCommand: (context, input, options) => command(context, `release.${input.kind}`, options, input, (state, requestId) => {
      read(state, context.scope); const data = deliveryState(state); let id: string;
      if (input.kind === "create") {
        const build = validateDraft(state, context.scope, input.input); id = allocate(state, "release");
        data.releases[id] = { id, scope: build.scope, revision: "r1", buildId: build.id, version: input.input.version, notes: input.input.notes, environmentId: build.scope.environmentId!, artifactIds: [...input.input.artifactIds], sourceRevision: build.inputs.commit, compatibility: input.input.compatibility, migration: input.input.migration, targetChannelId: input.input.channelId, status: "draft", actions: {} as Release["actions"] };
      } else {
        id = input.releaseId; const release = ownRelease(state, context.scope, id); revision(release.revision, options);
        if (input.kind === "edit" || input.kind === "delete") {
          configure(state, release.scope); if (!["draft", "publish_failed"].includes(release.status)) throw new Refusal("conflict", "Only a draft or failed publication can be edited/deleted.");
          if (input.kind === "delete") { delete data.releases[id]; mark(state, release.scope, id, "release.draft.deleted", requestId); return { message: "Draft removed; its unreferenced artifacts can now be removed separately." }; }
          const build = validateDraft(state, context.scope, input.input, id);
          if (build.id !== release.buildId) Object.assign(release, { operationId: undefined });
          Object.assign(release, { buildId: build.id, scope: build.scope, environmentId: build.scope.environmentId!, version: input.input.version, notes: input.input.notes, artifactIds: [...input.input.artifactIds], sourceRevision: build.inputs.commit, compatibility: input.input.compatibility, migration: input.input.migration, targetChannelId: input.input.channelId, status: "draft", revision: bump(release.revision) });
        } else {
          requirePermission(state, release.scope, "release.publish", wallTime());
          if (input.kind === "publish") {
            const channel = ownChannel(state, context.scope, release.targetChannelId); production(state, release.scope, input.confirmation, channel.name === "stable");
            if (!["draft", "publish_failed"].includes(release.status)) throw new Refusal("conflict", "Only draft or failed publication can be published.");
            const result = releaseReadiness(state, release, clock(state)); assertPreflight(result); if (channel.revision !== input.channelRevision) throw new Refusal("conflict", "Channel changed; review its current revision.");
            const operationId = release.operationId ?? operation(state, release.scope, actor(state), "release.publish", ["validate", "sign manifest", "upload assets", "commit channel pointer"], clock(state), requestId);
            if (release.operationId) { const op = state.operations[operationId]; Object.assign(op.record, { state: "queued", completedSteps: 0, revision: bump(op.record.revision), error: undefined, actorId: actor(state), updatedAt: iso(clock(state)) }); }
            data.jobs[operationId] = { resourceId: id, deadline: clock(state) + 1000, failure: data.scenario, channelId: channel.id, expectedChannelRevision: channel.revision };
            Object.assign(release, { status: "publishing", operationId, revision: bump(release.revision) }); mark(state, release.scope, id, "release.publishing", requestId);
            return { message: "Publishing started. The previous channel pointer remains available until atomic pointer commit.", resourceId: id, operationId };
          }
          if (release.status !== "published") throw new Refusal("conflict", "Only a published release can be withdrawn.");
          if (input.confirmation !== id) throw new Refusal("validation", `Type ${id} to stop future offers. Installed applications and downloaded bytes cannot be recalled.`);
          if (release.compatibility !== "carbon-polling-v1") throw new Refusal("unsupported_operation", "This client contract cannot consume withdrawal metadata.");
          const reason = required(input.reason, "Withdrawal reason"), replacementPlan = required(input.replacementPlan, "Replacement plan");
          Object.assign(release, { status: "withdrawn", withdrawal: { reason, replacementPlan, at: iso(clock(state)), metadataDigest: digest(`${id}:${reason}:${replacementPlan}`) }, revision: bump(release.revision) });
          for (const channel of Object.values(data.channels).filter(c => c.releaseId === id)) Object.assign(channel, { pausedAt: iso(clock(state)), status: "paused", revision: bump(channel.revision), history: [...channel.history, { action: "withdrawn", releaseId: id, rollout: channel.rollout, at: iso(clock(state)), actorId: actor(state) }] });
        }
      }
      mark(state, data.releases[id]?.scope ?? context.scope, id, `release.${input.kind}`, requestId); return { message: input.kind === "withdraw" ? "Withdrawal metadata recorded; affected channels paused. Historical metadata and bytes remain retained. No client downgrade or recall is claimed." : "Release draft saved.", resourceId: id };
    }),
    listChannels: (context, request) => run(state => { read(state, context.scope); return page(state, context.scope, Object.values(deliveryState(state).channels).filter(c => c.projectId === context.scope.projectId).map(c => channelDto(state, context.scope, c)), request); }, { signal: context.signal }),
    getChannel: (context, id) => run(state => channelDto(state, context.scope, ownChannel(state, context.scope, id)), { signal: context.signal }),
    channelCommand: (context, input, options) => command(context, `channel.${input.kind}`, options, input, (state, requestId) => {
      read(state, context.scope); const data = deliveryState(state); let id: string;
      if (input.kind === "create") {
        requirePermission(state, context.scope, "release.publish", wallTime()); const name = required(input.name, "Channel name", 40).toLowerCase(); if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Refusal("validation", "Channel name must be a lowercase slug.");
        if (Object.values(data.channels).some(c => c.projectId === context.scope.projectId && c.name === name)) throw new Refusal("conflict", "Channel name already exists.");
        id = allocate(state, "channel"); const template = Object.values(data.channels).find(c => c.projectId === context.scope.projectId)!;
        data.channels[id] = { ...structuredClone(template), id, name, revision: "r1", releaseId: undefined, rollout: 100, cohort: `cohort_${id}`, pausedAt: undefined, status: "empty", history: [], observations: { status: "not_reported", population: null, eligible: null, detail: "No delivery observations reported." } };
      } else {
        id = input.channelId; const channel = ownChannel(state, context.scope, id); revision(channel.revision, options);
        const release = "releaseId" in input ? ownRelease(state, context.scope, input.releaseId) : channel.releaseId ? ownRelease(state, context.scope, channel.releaseId) : undefined;
        requirePermission(state, release?.scope ?? context.scope, "release.publish", wallTime()); if (release) production(state, release.scope, input.confirmation, channel.name === "stable");
        if (input.kind === "promote" || input.kind === "rollback") {
          if (!release || release.status !== "published") throw new Refusal("validation", "Select a published, non-withdrawn release.");
          const result = releaseReadiness(state, { ...release, targetChannelId: channel.id }, clock(state)); assertPreflight(result);
          if (release.manifest?.signature !== "signed") throw new Refusal("validation", "The release needs a signed immutable manifest.");
          if (input.kind === "rollback") {
            if (!channel.history.some(h => h.previousReleaseId === release.id || h.releaseId === release.id) || release.id === channel.releaseId) throw new Refusal("validation", "Rollback must select a previous release in this channel's history.");
            const current = data.releases[channel.releaseId!];
            if (release.migration !== "compatible" || current?.migration !== "compatible" || current.environmentId !== release.environmentId) throw new Refusal("validation", "Rollback blocked by environment or forward-only/unknown migration compatibility. Data is not rolled back automatically.");
            if (release.artifactIds.some(a => data.artifacts[a].signature !== "signed")) throw new Refusal("validation", "Rollback requires signed artifacts.");
          }
          pointChannel(state, channel, release, actor(state), clock(state), input.kind);
        } else {
          if (!release) throw new Refusal("conflict", "Publish or promote a release before changing rollout.");
          if (release.compatibility !== "carbon-polling-v1") throw new Refusal("unsupported_operation", "Client protocol does not support rollout/pause.");
          if (input.kind === "rollout") { if (!Number.isInteger(input.percentage) || input.percentage < 0 || input.percentage > 100) throw new Refusal("validation", "Rollout must be an integer from 0 to 100."); if (release.status !== "published") throw new Refusal("conflict", "Withdrawn releases cannot be offered."); Object.assign(channel, { rollout: input.percentage }); }
          else { const permitted = channelDto(state, context.scope, channel).actions[input.kind]; if (!permitted.allowed) throw new Refusal("conflict", permitted.reason!); Object.assign(channel, { pausedAt: input.kind === "pause" ? iso(clock(state)) : undefined, status: input.kind === "pause" ? "paused" : "active" }); }
          Object.assign(channel, { revision: bump(channel.revision), history: [...channel.history, { action: input.kind, releaseId: release.id, rollout: channel.rollout, at: iso(clock(state)), actorId: actor(state) }] });
        }
      }
      mark(state, context.scope, id, `channel.${input.kind}`, requestId); return { message: "Channel state saved. Cohort identity is stable; future polling discovery changes do not prove delivery, recall or client downgrade.", resourceId: id };
    }),
  };
  return service;
}
