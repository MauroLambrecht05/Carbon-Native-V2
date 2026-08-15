// One tick of a worker's loop: claim whatever's next, run it, report back.
// Idle (nothing queued) is a normal outcome, not an error — a worker polls
// this in a loop and does nothing when it gets "idle" back.

import { join } from "node:path";
import { loadCarbonConfig } from "@carbon/workspace";
import type { TargetPlatform } from "@carbon/contracts/distribution";
import type { ControlPlaneClient } from "../ports/ControlPlaneClient.ts";
import type { RepoFetcher } from "../ports/RepoFetcher.ts";
import type { LocalPipeline } from "../ports/LocalPipeline.ts";
import type { ArtifactUploader } from "../ports/ArtifactUploader.ts";
import type { BuildArtifact } from "@carbon/cloud-orchestration";

export type JobOutcome = "idle" | "succeeded" | "failed";

export class RunNextJobUseCase {
  constructor(
    private readonly controlPlane: ControlPlaneClient,
    private readonly repos: RepoFetcher,
    private readonly pipeline: LocalPipeline,
    private readonly uploader: ArtifactUploader,
    private readonly workerId: string,
    private readonly platform: TargetPlatform,
    private readonly workDir: string,
  ) {}

  async execute(): Promise<JobOutcome> {
    const build = await this.controlPlane.claimNext(this.platform, this.workerId);
    if (!build) return "idle";

    try {
      await this.controlPlane.reportRunning(build.id);

      const projectDir = join(this.workDir, build.id);
      await this.repos.fetch(build.repoUrl, build.commitSha, projectDir);
      const config = await loadCarbonConfig(projectDir);

      const { binaryPath } = await this.pipeline.compile(projectDir, config);

      const artifacts: BuildArtifact[] = [];
      for (const target of build.targets) {
        const outDir = join(projectDir, "dist", "installers", target);
        const packaged = await this.pipeline.packageTarget(config, binaryPath, target, outDir);
        const { url } = await this.uploader.upload(
          packaged.path,
          `artifacts/${build.id}/${target}/${packaged.path.split(/[\\/]/).pop()}`,
        );
        artifacts.push({ target, path: packaged.path, sha256: packaged.sha256, url });
      }

      await this.controlPlane.reportSucceeded(build.id, artifacts);
      return "succeeded";
    } catch (error) {
      await this.controlPlane.reportFailed(build.id, error instanceof Error ? error.message : String(error));
      return "failed";
    }
  }
}
