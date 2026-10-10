import { afterEach, expect, test } from "bun:test";
import { createMockServices, type MockRuntime } from "../../infrastructure/browser/mock/create-mock-services";
import { MemoryPersistence } from "../../infrastructure/browser/mock/store";
import { seedFoundation } from "../../infrastructure/browser/mock/scenarios/foundation";
import { unwrap, type Result } from "../../presentation/framework/services/contracts";

const org = { orgId: "org_north" };
const project = { orgId: "org_north", projectId: "project_north_notes" };
let runtime: MockRuntime;
const code = (result: Result<unknown>) => result.ok ? undefined : result.error.code;
async function setup(identity = "owner") { runtime = createMockServices({ persistence: new MemoryPersistence(seedFoundation(1000)), wallTime: () => 1000, autoTick: false }); unwrap(await runtime.tools.setLatency(0)); unwrap(await runtime.tools.selectIdentity(identity)); return runtime.services.registry; }
afterEach(() => runtime?.dispose());

test("public discovery exposes signed metadata while private publisher records stay tenant scoped", async () => {
  const registry = await setup();
  const publicPackages = unwrap(await registry.listPackages(undefined, { filter: { name: "sqlite" }, windows: true }));
  expect(publicPackages.items[0].localSlug).toBe("sqlite");
  const version = unwrap(await registry.listVersions(publicPackages.items[0].id)).items[0];
  expect(version.synthetic).toBe(true); expect(version.archiveSignature).toBe("verified"); expect(version.targetTriple).toBe("x86_64-pc-windows-msvc");
  const created = unwrap(await registry.command({ scope: org }, { kind: "package.create", name: "Private Tool", localSlug: "private-tool", summary: "private fixture", category: "tools", license: "MIT", visibility: "private" }, { idempotencyKey: "private" }));
  expect(unwrap(await registry.getPackage(created.resourceId!)).visibility).toBe("private");
  unwrap(await runtime.services.session.signOut());
  expect(code(await registry.getPackage(created.resourceId!))).toBe("not_found");
});

test("submission review and publication keep immutable version bytes and reject duplicate semver", async () => {
  const registry = await setup();
  const pkg = unwrap(await registry.command({ scope: org }, { kind: "package.create", name: "Charts", localSlug: "charts", summary: "chart plugin", category: "ui", license: "MIT", visibility: "public" }, { idempotencyKey: "pkg" })).resourceId!;
  const rejected = unwrap(await registry.command({ scope: org }, { kind: "version.submit", packageId: pkg, version: "1.0.0", capabilities: [], changelog: "first", readme: "# Charts", runtime: ">=0.9 <2", abi: "carbon-plugin-1", invalidFixture: true }, { idempotencyKey: "bad" })).resourceId!;
  expect(unwrap(await registry.getVersion(pkg, rejected)).state).toBe("rejected");
  const approved = unwrap(await registry.command({ scope: org }, { kind: "version.submit", packageId: pkg, version: "1.0.1", capabilities: ["network:api"], changelog: "fixed", readme: "# Charts", runtime: ">=0.9 <2", abi: "carbon-plugin-1" }, { idempotencyKey: "good" })).resourceId!;
  const draft = unwrap(await registry.getVersion(pkg, approved)); expect(draft.state).toBe("approved");
  unwrap(await registry.command({ scope: org }, { kind: "version.publish", packageId: pkg, versionId: approved }, { idempotencyKey: "publish", expectedRevision: draft.revision }));
  const published = unwrap(await registry.getVersion(pkg, approved)); expect(published.state).toBe("published"); expect(published.archiveSignature).toBe("verified");
  expect(code(await registry.command({ scope: org }, { kind: "version.submit", packageId: pkg, version: "1.0.1", capabilities: [], changelog: "replace", readme: "changed", runtime: ">=0.9 <2", abi: "carbon-plugin-1" }, { idempotencyKey: "duplicate" }))).toBe("conflict");
});

test("capability consent precedes exact lock and source synchronization feeds future build provenance", async () => {
  const registry = await setup(); const pkg = unwrap(await registry.listPackages(undefined, { filter: { name: "SQLite" } })).items[0]; const version = unwrap(await registry.listVersions(pkg.id)).items[0];
  const preflight = unwrap(await registry.resolve({ scope: project }, pkg.id, version.id)); expect(preflight.allowed).toBe(false); expect(preflight.missingGrants).toEqual(["filesystem:app-data"]);
  expect(code(await registry.dependencyCommand({ scope: project }, { kind: "dependency.add", packageId: pkg.id, versionId: version.id, grants: [] }, { idempotencyKey: "denied" }))).toBe("validation");
  const id = unwrap(await registry.dependencyCommand({ scope: project }, { kind: "dependency.add", packageId: pkg.id, versionId: version.id, grants: ["filesystem:app-data"] }, { idempotencyKey: "add" })).resourceId!;
  let dep = unwrap(await registry.getDependency({ scope: project }, id)); expect(dep.status).toBe("proposal_ready"); expect(dep.digest).toBe(version.digest);
  unwrap(await registry.dependencyCommand({ scope: project }, { kind: "dependency.sync", id }, { idempotencyKey: "sync", expectedRevision: dep.revision }));
  dep = unwrap(await registry.getDependency({ scope: project }, id)); expect(dep.status).toBe("source_synchronized"); expect(dep.repositoryRevision).toContain("sha256:"); expect(dep.actions.build.allowed).toBe(true);
});

test("developer project authority is enforced independently from Registry visibility", async () => {
  const registry = await setup("viewer"); const pkg = unwrap(await registry.listPackages()).items[0], version = unwrap(await registry.listVersions(pkg.id)).items[0];
  expect(code(await registry.dependencyCommand({ scope: project }, { kind: "dependency.add", packageId: pkg.id, versionId: version.id, grants: ["filesystem:app-data"] }, { idempotencyKey: "viewer" }))).toBe("forbidden");
  expect(code(await registry.listDependencies({ scope: { orgId: "org_south", projectId: "project_south_notes" } }))).toBe("not_found");
});
