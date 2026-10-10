import type { Artifact, Build, BuildLog, BuildSettings, Channel, PluginSnapshot, Release, SigningSettings, Worker } from "../../../presentation/framework/services/delivery-contracts";
import type { MockState } from "./store";
import { configurationState } from "./configuration-state";

export type DeliveryScenario = "success" | "build_failure" | "lease_expiry" | "lease_exhaustion" | "timeout" | "publish_failure" | "quota" | "no_capacity" | "plugin_revoked" | "plugin_incompatible" | "signing_invalid" | "signing_unknown" | "signing_expired" | "stale_ref" | "lost_response";
export interface DeliveryState {
  settings: Record<string, BuildSettings>;
  signing: Record<string, SigningSettings>;
  builds: Record<string, Build>;
  artifacts: Record<string, Artifact>;
  logs: Record<string, BuildLog[]>;
  workers: Record<string, Worker>;
  releases: Record<string, Release>;
  channels: Record<string, Channel>;
  jobs: Record<string, { resourceId: string; deadline: number; failure: DeliveryScenario; expectedChannelRevision?: string; channelId?: string; forcedLeaseExpiryAttempt?: number }>;
  providerEvents: Record<string, { fingerprint: string; buildId: string }>;
  usage: Record<string, { orgId: string; projectId: string; buildId: string; attemptId: string; minutes: number }>;
  plugins: Record<string, PluginSnapshot[]>;
  scenario: DeliveryScenario;
}
export const action = (allowed: boolean, reason = "This transition is unavailable in the current state.") => allowed ? { allowed } : { allowed, reason };
export const digest = (value: string) => {
  // Deterministic fixture digest, explicitly not a cryptographic signing implementation.
  let hash = 2166136261;
  for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return `fixture-sha256:${(hash >>> 0).toString(16).padStart(8, "0").repeat(8)}`;
};
export const terminalBuild = (build: Build) => ["succeeded", "failed", "cancelled"].includes(build.status);
export const stageNames = ["fetch", "dependencies", "bundle", "package", "sign", "upload", "finalize"] as const;
export function deliveryState(state: MockState): DeliveryState {
  state.delivery ??= { settings: {}, signing: {}, builds: {}, artifacts: {}, logs: {}, workers: {}, releases: {}, channels: {}, jobs: {}, providerEvents: {}, usage: {}, plugins: {}, scenario: "success" };
  const data = state.delivery, configuration = configurationState(state);
  for (const project of Object.values(state.projects)) {
    data.settings[project.id] ??= {
      projectId: project.id, revision: "r1", formats: ["nsis"], profile: "release", toolchain: "carbon-windows-1.0", timeoutMinutes: 15, maxAttempts: 2,
      workerPool: "managed", cacheGeneration: 1, invalidateNext: false, configurationStatus: "synchronized",
      manifest: { appId: project.id, name: project.name, version: "1.0.0", digest: digest(`${project.id}:manifest:1.0.0`), source: "repository" },
    };
    data.signing[project.id] ??= {
      projectId: project.id, revision: "r1", requireSignedProduction: true,
      certificate: project.id === "project_north_notes" ? { state: "signed", subject: "Carbon Notes (fixture certificate)", expiresAt: "2027-09-06T12:00:00.000Z", secretId: "secret_north_notes_signing", secretVersion: 2 } : { state: "not_configured" },
      keys: [{ id: `key_${project.id}_1`, publicKey: `MOCK-PUBLIC-KEY-${project.id}-1`, state: "active", createdAt: "2026-09-06T12:00:00.000Z" }],
      actions: { configure: action(false), rotate: action(false) },
    };
    data.plugins[project.id] ??= [];
    for (const name of ["stable", "beta"]) {
      const id = `channel_${project.id}_${name}`;
      data.channels[id] ??= {
        id, projectId: project.id, name, revision: "r1", rollout: 100, cohort: `cohort_${id}`, status: "empty", history: [],
        observations: { status: "not_reported", population: null, eligible: null, detail: "No client observations reported. Discovery uses polling; publication does not prove delivery." },
        actions: { update: action(false), pause: action(false), resume: action(false), rollback: action(false) },
      };
    }
  }
  const secret = configuration.secrets.secret_north_notes_signing;
  if (secret?.bindings.includes("Windows signing configuration (Slice 4)")) Object.assign(secret, { bindings: [`Windows signing:project_north_notes`] });
  return data;
}
