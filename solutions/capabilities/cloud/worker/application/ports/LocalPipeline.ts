// The local build-to-artifact pipeline, behind a port so RunNextJobUseCase's
// orchestration (claim -> compile -> package each target -> report) is
// testable without actually invoking bun/cargo/dpkg-deb. The real
// implementation composes @carbon/bundling, @carbon/packaging and
// @carbon/signing — capabilities that already have their own test suites,
// so this port exists to isolate orchestration logic, not to re-test them.

import type { CarbonConfig } from "@carbon/contracts/app";
import type { InstallerTargetId } from "@carbon/contracts/distribution";

export interface PackagedTarget {
  readonly target: InstallerTargetId;
  readonly path: string;
  readonly sha256: string;
}

export interface LocalPipeline {
  /** bun install + build the runtime binary + bundle the app. Once per job. */
  compile(projectDir: string, config: CarbonConfig): Promise<{ binaryPath: string }>;
  /** Generate + build + sign the installer for one target. Once per target. */
  packageTarget(
    config: CarbonConfig,
    binaryPath: string,
    target: InstallerTargetId,
    outDir: string,
  ): Promise<PackagedTarget>;
}
