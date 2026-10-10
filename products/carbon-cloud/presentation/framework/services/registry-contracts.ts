import type { AccountContext, Action, CommandOptions, Page, PageRequest, RequestContext, Result, Scope } from "./contracts";
import type { CommandReceipt } from "./identity-contracts";

export type TrustState = "verified" | "unknown" | "revoked";
export type ReviewState = "draft" | "validating" | "rejected" | "approved" | "published" | "deprecated" | "revoked";
export type RegistryPackage = Readonly<{
  id: string; namespace: string; name: string; localSlug: string; summary: string;
  category: string; license: string; visibility: "public" | "private"; publisherOrgId: string;
  trust: TrustState; latestVersion?: string; revision: string; capabilities: readonly string[];
}>;
export type PackageVersion = Readonly<{
  id: string; packageId: string; version: string; state: ReviewState; targetTriple: "x86_64-pc-windows-msvc";
  runtime: string; abi: string; digest: string; archiveSignature: "verified" | "pending" | "revoked";
  binarySignature: "verified" | "developer" | "unknown"; capabilities: readonly string[];
  dependencies: readonly { packageId: string; range: string }[]; readme: string; changelog: string;
  manifest: string; synthetic: true; review: readonly string[]; publishedAt?: string;
  deprecation?: { reason: string; replacement?: string }; revocation?: { reason: string; at: string };
  revision: string;
}>;
export type Dependency = Readonly<{
  id: string; scope: Scope; packageId: string; requested: string; resolvedVersionId: string;
  version: string; digest: string; trust: TrustState; capabilities: readonly string[]; grants: readonly string[];
  status: "desired" | "proposal_ready" | "source_synchronized" | "disabled" | "blocked";
  repositoryRevision?: string; builtIn: readonly string[]; releasedIn: readonly string[]; revision: string;
  actions: { sync: Action; build: Action };
}>;
export type ResolutionPlan = Readonly<{
  allowed: boolean; package: RegistryPackage; version: PackageVersion;
  changes: readonly string[]; requiredCapabilities: readonly string[]; missingGrants: readonly string[];
  conflicts: readonly string[]; trust: TrustState;
}>;
export type RegistryFilter = PageRequest & { category?: string; capability?: string; license?: string; trust?: TrustState; windows?: boolean };
export type RegistryCommand =
  | { kind: "package.create"; name: string; localSlug: string; summary: string; category: string; license: string; visibility: "public" | "private" }
  | { kind: "package.update"; packageId: string; summary: string; visibility: "public" | "private" }
  | { kind: "version.submit"; packageId: string; version: string; capabilities: string[]; changelog: string; readme: string; runtime: string; abi: string; invalidFixture?: boolean }
  | { kind: "version.publish"; packageId: string; versionId: string }
  | { kind: "version.deprecate"; packageId: string; versionId: string; reason: string; replacement?: string }
  | { kind: "package.report"; packageId: string; versionId?: string; reason: string };
export type DependencyCommand =
  | { kind: "dependency.add"; packageId: string; versionId: string; grants: string[] }
  | { kind: "dependency.update"; id: string; versionId: string; grants: string[] }
  | { kind: "dependency.grants"; id: string; grants: string[]; productionConfirmation?: string }
  | { kind: "dependency.sync"; id: string }
  | { kind: "dependency.disable"; id: string; disabled: boolean }
  | { kind: "dependency.remove"; id: string };

export interface RegistryService {
  listPackages(context?: AccountContext, page?: RegistryFilter): Promise<Result<Page<RegistryPackage>>>;
  getPackage(id: string, context?: AccountContext): Promise<Result<RegistryPackage>>;
  listVersions(id: string, context?: AccountContext, page?: PageRequest): Promise<Result<Page<PackageVersion>>>;
  getVersion(packageId: string, versionId: string, context?: AccountContext): Promise<Result<PackageVersion>>;
  listPublishing(context: RequestContext, page?: PageRequest): Promise<Result<Page<RegistryPackage>>>;
  command(context: RequestContext, command: RegistryCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
  listDependencies(context: RequestContext, page?: PageRequest): Promise<Result<Page<Dependency>>>;
  getDependency(context: RequestContext, id: string): Promise<Result<Dependency>>;
  resolve(context: RequestContext, packageId: string, versionId: string, dependencyId?: string): Promise<Result<ResolutionPlan>>;
  dependencyCommand(context: RequestContext, command: DependencyCommand, options: CommandOptions): Promise<Result<CommandReceipt>>;
}
