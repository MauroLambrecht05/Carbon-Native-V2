import type { Dependency, PackageVersion, RegistryPackage } from "../../../presentation/framework/services/registry-contracts";
import type { MockState } from "./store";

export interface RegistryState { packages: Record<string, RegistryPackage>; versions: Record<string, PackageVersion>; dependencies: Record<string, Dependency>; reports: Record<string, { id: string; packageId: string; versionId?: string; reason: string; actorId: string; createdAt: string }>; }
export function registryState(state: MockState): RegistryState {
  if (!state.registry) {
    const pkg: RegistryPackage = { id: "pkg_carbon_sqlite", namespace: "carbon", name: "SQLite", localSlug: "sqlite", summary: "Embedded SQLite integration for Windows desktop apps.", category: "database", license: "MIT", visibility: "public", publisherOrgId: "org_north", trust: "verified", latestVersion: "1.2.0", revision: "r1", capabilities: ["filesystem:app-data"] };
    const version: PackageVersion = { id: "pkgver_carbon_sqlite_1_2_0", packageId: pkg.id, version: "1.2.0", state: "published", targetTriple: "x86_64-pc-windows-msvc", runtime: ">=0.9 <2", abi: "carbon-plugin-1", digest: "sha256:fixture-sqlite-120", archiveSignature: "verified", binarySignature: "verified", capabilities: ["filesystem:app-data"], dependencies: [], readme: "# SQLite\nSynthetic Registry fixture for the Windows plugin workflow.", changelog: "Adds deterministic mock migrations.", manifest: 'name = "sqlite"\nversion = "1.2.0"\ntarget = "x86_64-pc-windows-msvc"', synthetic: true, review: ["Archive paths validated", "Windows DLL kind validated", "Import policy passed", "Compatibility passed"], publishedAt: "2026-09-06T12:00:00.000Z", revision: "r1" };
    state.registry = { packages: { [pkg.id]: pkg }, versions: { [version.id]: version }, dependencies: {}, reports: {} };
  }
  return state.registry;
}
