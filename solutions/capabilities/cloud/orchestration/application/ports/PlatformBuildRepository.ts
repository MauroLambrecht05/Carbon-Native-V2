import type { WorkerLeaseInput } from '@carbon/catalog';
import type {
  Build, BuildArtifact, BuildArtifactDeclare, BuildDetails, BuildLogAppend, BuildLogSegment, BuildProvenance, BuildReceipt, BuildSource, EnvironmentScope, WorkerBuildComplete, WorkerBuildInput,
} from '@carbon/contracts/platform';
import type { OrganizationActor } from '@carbon/identity';

export interface BuildCreation {
  readonly actor: OrganizationActor; readonly scope: EnvironmentScope; readonly id: string; readonly leaseId: string; readonly source: BuildSource; readonly sourceDigest: string;
  readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}
export interface BuildCancellation {
  readonly actor: OrganizationActor; readonly scope: EnvironmentScope; readonly buildId: string; readonly expectedRevision: string;
  readonly keyDigest: string; readonly requestDigest: string; readonly requestId: string;
}

export interface PlatformBuildRepository {
  // Developers, through the browser session.
  create(input: BuildCreation): Promise<BuildReceipt>;
  list(actor: OrganizationActor, scope: EnvironmentScope, limit: number, afterId?: string): Promise<readonly Build[]>;
  get(actor: OrganizationActor, scope: EnvironmentScope, id: string): Promise<BuildDetails>;
  logs(actor: OrganizationActor, scope: EnvironmentScope, id: string, after: number, limit: number): Promise<readonly BuildLogSegment[]>;
  cancel(input: BuildCancellation): Promise<BuildReceipt>;
  provenance(actor: OrganizationActor, scope: EnvironmentScope, id: string): Promise<BuildProvenance>;
  // The worker that holds the build's lease.
  input(lease: WorkerLeaseInput): Promise<WorkerBuildInput>;
  appendLog(lease: WorkerLeaseInput, segment: BuildLogAppend): Promise<{ readonly nextLogSequence: number }>;
  declareArtifact(lease: WorkerLeaseInput, artifact: BuildArtifactDeclare): Promise<BuildArtifact>;
  /** What this attempt has declared so far, for verification before success is accepted. */
  declared(lease: WorkerLeaseInput): Promise<readonly BuildArtifact[]>;
  complete(lease: WorkerLeaseInput, result: WorkerBuildComplete): Promise<Build>;
  // Cloud's own timer. No HTTP route reaches this.
  reconcile(requestId: string, limit: number): Promise<readonly Build[]>;
}

/**
 * Checks a declared artifact against object storage: the object must exist under exactly this key with exactly this
 * size and SHA-256. Cloud accepts a build as succeeded only after every declared artifact passes.
 */
export interface ArtifactVerifier { verify(artifact: { readonly objectKey: string; readonly sizeBytes: number; readonly sha256: string }): Promise<boolean> }
/** Signs the canonical provenance statement. The key identifier lets a consumer pick the matching public key. */
export interface ProvenanceSigner { readonly keyId: string; sign(statement: string): string }
