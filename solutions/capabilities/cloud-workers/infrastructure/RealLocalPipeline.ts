// The real LocalPipeline: what a worker actually runs, composing the same
// capabilities `carbon build` / `carbon bundle` do — see
// products/carbon-cli/presentation/commands/build/run.command.ts, which
// this mirrors instead of reinventing.

import { join } from "node:path";
import type { CarbonConfig } from "@carbon/contracts/app";
import type { InstallerTargetId } from "@carbon/contracts/distribution";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";
import { generatePackageUseCase, buildPackageUseCase } from "@carbon/packaging";
import { signFile, readSecretKey } from "@carbon/signing";
import type { Logger } from "@carbon/logging";
import type { LocalPipeline, PackagedTarget } from "../application/ports/LocalPipeline.ts";

export interface SigningKey {
  readonly keyFile: string;
  readonly password: string;
}

export class RealLocalPipeline implements LocalPipeline {
  constructor(private readonly logger: Logger, private readonly signingKey?: SigningKey) {
    // Fails fast on a bad key/password rather than on the first artifact of
    // the first job — a worker that can't sign shouldn't claim work at all.
    if (signingKey) readSecretKey(signingKey.keyFile, signingKey.password);
  }

  async compile(projectDir: string, config: CarbonConfig): Promise<{ binaryPath: string }> {
    await ensureNodeModules(projectDir, this.logger);
    const binaryPath = await ensureRuntime(config.runtime.backend, this.logger);
    await buildProject(projectDir, config.runtime.backend, this.logger, { bytecode: true });
    return { binaryPath };
  }

  async packageTarget(
    config: CarbonConfig,
    binaryPath: string,
    target: InstallerTargetId,
    outDir: string,
  ): Promise<PackagedTarget> {
    await generatePackageUseCase().execute({ target, config, binaryPath, outputDir: outDir });
    const built = await buildPackageUseCase().execute({ target, config, binaryPath, dir: join(outDir, target) });

    if (this.signingKey) {
      signFile(built.outputPath, this.signingKey.keyFile, this.signingKey.password);
    }

    const sha256 = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(built.outputPath).arrayBuffer())
      .digest("hex");

    return { target, path: built.outputPath, sha256 };
  }
}
