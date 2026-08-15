// What a worker needs from Carbon Cloud's control plane. Mirrors the four
// operations products/carbon-cloud/infrastructure/http exposes; a worker
// depends on this port, not on fetch() or a base URL, so RunNextJobUseCase
// is testable without a real server.

import type { TargetPlatform } from "@carbon/contracts/distribution";
import type { BuildArtifact, BuildProps } from "@carbon/cloud-orchestration";

export interface ControlPlaneClient {
  claimNext(platform: TargetPlatform, workerId: string): Promise<BuildProps | null>;
  reportRunning(buildId: string): Promise<void>;
  reportSucceeded(buildId: string, artifacts: readonly BuildArtifact[]): Promise<void>;
  reportFailed(buildId: string, error: string): Promise<void>;
}
