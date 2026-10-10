import { afterEach, expect, test } from "bun:test";
import { createMockServices, type MockRuntime } from "../../infrastructure/browser/mock/create-mock-services";
import { MemoryPersistence } from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import { unwrap, type Result } from "../../presentation/framework/services/contracts";

const project = { orgId: "org_north", projectId: "project_north_desk" };
const environment = { ...project, environmentId: "env_north_desk_development" };
let runtime: MockRuntime;
function errorCode(result: Result<unknown>) { return result.ok ? undefined : result.error.code; }
async function setup(identity = "owner") {
  runtime = createMockServices({ persistence: new MemoryPersistence(seedFoundation(1000)), wallTime: () => 1000, autoTick: false });
  unwrap(await runtime.tools.setLatency(0));
  unwrap(await runtime.tools.selectIdentity(identity));
  return runtime.services.configuration;
}
afterEach(() => runtime?.dispose());

test("repository state drives setup and applies a local configuration proposal", async () => {
  const service = await setup();
  expect(unwrap(await service.getSetupChecklist({ scope: project })).find(item => item.id === "repository")?.status).toBe("action_required");
  const current = unwrap(await service.getRepository({ scope: project }));
  unwrap(await service.repositoryCommand({ scope: project }, { kind: "repository-save", installationId: "installation_north_github", repository: "acme/desk", branch: "main", rootDirectory: "apps/desktop", pushTrigger: true, pullRequestTrigger: true }, { idempotencyKey: "repo", expectedRevision: current.revision }));
  const saved = unwrap(await service.getRepository({ scope: project }));
  expect(saved.manifest.status).toBe("ready");
  expect(saved.proposal.status).toBe("pending");
  unwrap(await service.repositoryCommand({ scope: project }, { kind: "proposal-apply" }, { idempotencyKey: "proposal", expectedRevision: saved.revision }));
  expect(unwrap(await service.getSetupChecklist({ scope: project })).find(item => item.id === "repository")?.status).toBe("complete");
});

test("credentials are shown once while secret values never enter stored metadata", async () => {
  const service = await setup();
  const created = unwrap(await service.credentialCommand({ scope: environment }, { kind: "credential-create", name: "Backend", audience: "backend", actions: ["data:read"], expiryDays: 30 }, { idempotencyKey: "credential" }));
  expect(created.secretValue).toStartWith("cc_env_");
  expect(unwrap(await service.listEnvironmentCredentials({ scope: environment })).items.some(item => item.id === created.resourceId && !Object.hasOwn(item, "secretValue"))).toBe(true);
  unwrap(await service.secretCommand({ scope: environment }, { kind: "secret-create", name: "PRIVATE_KEY", type: "generic", value: "must-never-persist" }, { idempotencyKey: "secret" }));
  const metadata = unwrap(await service.listSecrets({ scope: environment })).items.find(item => item.name === "PRIVATE_KEY")!;
  expect(JSON.stringify(metadata)).not.toContain("must-never-persist");
  expect(errorCode(await service.secretCommand({ scope: { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" } }, { kind: "secret-remove", secretId: "secret_north_notes_signing" }, { idempotencyKey: "bound", expectedRevision: "r1" }))).toBe("conflict");
});

test("a developer cannot grant credential actions outside their effective data access", async () => {
  const service = await setup("developer");
  const scope = { orgId: "org_north", projectId: "project_north_notes", environmentId: "env_north_notes_development" };
  expect(errorCode(await service.credentialCommand({ scope }, { kind: "credential-create", name: "Overgrant", audience: "backend", actions: ["data:read"], expiryDays: 30 }, { idempotencyKey: "overgrant" }))).toBe("forbidden");
  expect((await service.credentialCommand({ scope }, { kind: "credential-create", name: "Build trigger", audience: "ci", actions: ["builds:trigger"], expiryDays: 30 }, { idempotencyKey: "allowed" })).ok).toBe(true);
});

test("device authorization is one-use and audited configuration can be filtered", async () => {
  const service = await setup();
  const request = unwrap(await service.getDeviceRequest("carbon-7f3k"));
  unwrap(await service.respondDeviceRequest(request.code, true, { idempotencyKey: "device", expectedRevision: request.revision }));
  expect(unwrap(await service.listDeviceGrants()).items.some(item => item.device === "Developer workstation" && item.status === "active")).toBe(true);
  expect(errorCode(await service.respondDeviceRequest(request.code, true, { idempotencyKey: "again", expectedRevision: request.revision }))).toBe("conflict");
  const repo = unwrap(await service.getRepository({ scope: project }));
  unwrap(await service.repositoryCommand({ scope: project }, { kind: "repository-clear", confirmation: repo.repository! }, { idempotencyKey: "clear", expectedRevision: repo.revision }));
  const activity = unwrap(await runtime.services.activity.listAudit({ scope: project }, { action: "repository-clear" }));
  expect(activity.items).toHaveLength(1);
  expect(activity.items[0].metadata).toEqual({ provider: "github" });
});
