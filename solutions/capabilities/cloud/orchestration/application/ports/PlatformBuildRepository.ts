import type { WorkerLeaseInput } from '@carbon/catalog';
import type {
  Build, BuildArtifact, BuildArtifactDeclare, BuildDetails, BuildLogAppend, BuildLogSegment, BuildReceipt, BuildSource, EnvironmentScope, WorkerBuildComplete, WorkerBuildInput,
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
  // The worker that holds the build's lease.
  input(lease: WorkerLeaseInput): Promise<WorkerBuildInput>;
  appendLog(lease: WorkerLeaseInput, segment: BuildLogAppend): Promise<{ readonly nextLogSequence: number }>;
  declareArtifact(lease: WorkerLeaseInput, artifact: BuildArtifactDeclare): Promise<BuildArtifact>;
  complete(lease: WorkerLeaseInput, result: WorkerBuildComplete): Promise<Build>;
  // Cloud's own timer. No HTTP route reaches this.
  reconcile(requestId: string, limit: number): Promise<readonly Build[]>;
}
