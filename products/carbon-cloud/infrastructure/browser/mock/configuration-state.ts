import type {
  DeviceGrant,
  DeviceRequest,
  EnvironmentCredential,
  OrganizationCredential,
  PersonalCredential,
  RepositoryConfiguration,
  RepositoryInstallation,
  SecretMetadata,
  ServiceAccount,
} from "../../../presentation/framework/services/configuration-contracts";
import type { MockState } from "./store";
import { now } from "./clock";

export interface ConfigurationState {
  installations: Record<string, RepositoryInstallation>;
  repositories: Record<string, RepositoryConfiguration>;
  environmentCredentials: Record<string, EnvironmentCredential>;
  secrets: Record<string, SecretMetadata>;
  serviceAccounts: Record<string, ServiceAccount>;
  organizationCredentials: Record<string, OrganizationCredential>;
  personalCredentials: Record<string, PersonalCredential>;
  deviceRequests: Record<string, DeviceRequest>;
  deviceGrants: Record<string, DeviceGrant>;
}

const seededAt = "2026-09-06T12:00:00.000Z";
export function configurationState(state: MockState): ConfigurationState {
  if (!state.configuration) {
    const northInstallation: RepositoryInstallation = {
      id: "installation_north_github", orgId: "org_north", provider: "github",
      account: "acme-engineering", scopes: ["metadata:read", "contents:read"],
      repositories: ["acme/notes", "acme/desk"], status: "connected", connectedAt: seededAt,
      dependentProjectIds: ["project_north_notes", "project_north_desk"], revision: "r1",
    };
    const southInstallation: RepositoryInstallation = {
      id: "installation_south_github", orgId: "org_south", provider: "github",
      account: "acme-south", scopes: ["metadata:read", "contents:read"],
      repositories: ["acme-south/notes"], status: "attention", connectedAt: seededAt,
      dependentProjectIds: ["project_south_notes"], revision: "r1",
    };
    state.configuration = {
      installations: { [northInstallation.id]: northInstallation, [southInstallation.id]: southInstallation },
      repositories: {
        project_north_notes: repository("project_north_notes", northInstallation.id, "acme/notes", "ready", "Carbon manifest found at apps/desktop/carbon.json."),
        project_north_desk: repository("project_north_desk", northInstallation.id, "acme/desk", "missing", "No Carbon manifest was found under the selected directory."),
        project_south_notes: repository("project_south_notes", southInstallation.id, "acme-south/notes", "conflict", "Repository configuration differs from the saved dashboard revision."),
      },
      environmentCredentials: {
        credential_env_north_notes_development: {
          id: "credential_env_north_notes_development",
          scope: { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" },
          name: "desktop-release CI", audience: "ci", resources: ["builds"], actions: ["builds:trigger"], prefix: "cc_env_71C2",
          status: "active", createdAt: seededAt, expiresAt: "2026-12-05T12:00:00.000Z",
          lastUsedAt: "2026-09-06T12:04:00.000Z", dependents: ["CI workflow: desktop-release"], revision: "r1",
        },
      },
      secrets: {
        secret_north_notes_signing: {
          id: "secret_north_notes_signing",
          scope: { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" },
          name: "WINDOWS_SIGNING_REFERENCE", type: "signing", version: 2,
          createdAt: seededAt, updatedAt: seededAt,
          bindings: ["Windows signing configuration (Slice 4)"], revision: "r1",
        },
      },
      serviceAccounts: {
        service_account_release: {
          id: "service_account_release", orgId: "org_north", name: "Release automation", status: "active",
          grants: [{ scope: { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" }, actions: ["builds:trigger"] }],
          credentialIds: ["org_credential_release"], revision: "r1",
        },
      },
      organizationCredentials: {
        org_credential_release: {
          id: "org_credential_release", orgId: "org_north", serviceAccountId: "service_account_release",
          name: "release runner", prefix: "cc_org_39AF", status: "active",
          expiresAt: "2026-12-05T12:00:00.000Z", lastUsedAt: "2026-09-06T12:03:00.000Z", revision: "r1",
        },
      },
      personalCredentials: {},
      deviceRequests: {
        "CARBON-7F3K": {
          code: "CARBON-7F3K", client: "Carbon CLI", device: "Developer workstation",
          orgId: "org_north", organization: "Acme North",
          scopes: ["projects:read", "builds:trigger"], status: "pending",
          expiresAt: "2026-09-06T12:30:00.000Z", revision: "r1",
        },
      },
      deviceGrants: {
        device_owner_cli: {
          id: "device_owner_cli", accountId: "owner", kind: "device", client: "Carbon CLI", device: "Alex's workstation",
          orgId: "org_north", scopes: ["projects:read"], status: "active", authorizedAt: seededAt,
          lastUsedAt: "2026-09-06T12:05:00.000Z", affectedProjectIds: ["project_north_notes", "project_north_desk"], revision: "r1",
        },
        integration_owner_github: {
          id: "integration_owner_github", accountId: "owner", kind: "provider", client: "GitHub integration", device: "acme-engineering OAuth grant",
          orgId: "org_north", scopes: ["repository:read"], status: "active", authorizedAt: seededAt,
          lastUsedAt: "2026-09-06T12:02:00.000Z", affectedProjectIds: ["project_north_notes", "project_north_desk"], revision: "r1",
        },
      },
    };
  }
  const data = state.configuration;
  for (const project of Object.values(state.projects)) data.repositories[project.id] ??= repository(project.id);
  for (const installation of Object.values(data.installations)) {
    Object.assign(installation, { dependentProjectIds: Object.values(data.repositories)
      .filter(item => item.installationId === installation.id)
      .map(item => item.projectId) });
  }
  return data;
}

export function reconcileConfiguration(state: MockState, wall: number): boolean {
  const initial = !state.configuration;
  const data = configurationState(state);
  const time = now(state.clock, wall);
  let changed = initial;
  for (const item of [...Object.values(data.environmentCredentials), ...Object.values(data.organizationCredentials), ...Object.values(data.personalCredentials)]) {
    if (item.status === "active" && Date.parse(item.expiresAt) <= time) {
      Object.assign(item, { status: "expired", revision: bumpRevision(item.revision) });
      changed = true;
    }
  }
  for (const item of Object.values(data.environmentCredentials)) {
    if (item.status === "expiring" && item.overlapEndsAt && Date.parse(item.overlapEndsAt) <= time) {
      Object.assign(item, { status: "revoked", revision: bumpRevision(item.revision) });
      changed = true;
    }
  }
  for (const item of Object.values(data.deviceRequests)) {
    if (item.status === "pending" && Date.parse(item.expiresAt) <= time) {
      Object.assign(item, { status: "expired", revision: bumpRevision(item.revision) });
      changed = true;
    }
  }
  return changed;
}

const bumpRevision = (value: string) => `r${Number(value.slice(1)) + 1}`;

function repository(projectId: string, installationId?: string, name?: string, status: RepositoryConfiguration["manifest"]["status"] = "unconfigured", message = "Choose an organization repository connection to begin."): RepositoryConfiguration {
  return {
    projectId, ...(installationId ? { installationId } : {}), ...(name ? { repository: name } : {}),
    branch: "main", rootDirectory: name?.endsWith("notes") ? "apps/desktop" : ".",
    pushTrigger: true, pullRequestTrigger: false,
    manifest: { status, ...(status === "ready" ? { path: name?.endsWith("notes") ? "apps/desktop/carbon.json" : "carbon.json" } : {}), message },
    proposal: { status: status === "ready" ? "applied" : "none" }, revision: "r1",
  };
}
