// The real LocalPipeline: what a worker actually runs, composing the same
// capabilities `carbon build` / `carbon bundle` do — see
// products/carbon-cli/presentation/commands/build/run.command.ts, which
// this mirrors instead of reinventing.

import { join } from "node:path";
import type { CarbonConfig } from "@carbon/contracts/app";
import type { InstallerTargetId } from "@carbon/contracts/distribution";
import { buildProject, ensureNodeModules, ensureRuntime } from "@carbon/bundling";
import { generatePackageUseCase, buildPackageUseCase } from "@carbon/packaging";
import {
  signFile,
  readSecretKey,
  signAuthenticode,
  signAndNotarizeMacOs,
  type AuthenticodeCredentials,
  type MacOsCredentials,
} from "@carbon/signing";
import { nodeProcessRunner } from "@carbon/process";
import type { Logger } from "@carbon/logging";
import type { LocalPipeline, PackagedTarget } from "../application/ports/LocalPipeline.ts";

export interface SigningKey {
  readonly keyFile: string;
  readonly password: string;
}

// nsis/wix produce a real Windows executable/MSI; a minisign signature on
// disk means nothing to Windows itself (SmartScreen, Defender) — that needs
// Authenticode. Every other target's minisign signature is the only one
// that applies.
const AUTHENTICODE_TARGETS: readonly InstallerTargetId[] = ["nsis", "wix"];

export class RealLocalPipeline implements LocalPipeline {
  constructor(
    private readonly logger: Logger,
    private readonly signingKey?: SigningKey,
    private readonly authenticode?: AuthenticodeCredentials,
    private readonly macos?: MacOsCredentials,
  ) {
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
    // dmg is the odd one out: Gatekeeper checks the signature on the binary
    // a user actually runs, and appdmg copies binaryPath INTO the dmg at
    // build time — so this has to sign binaryPath before packaging, not the
    // .dmg after, the way Authenticode signs the finished nsis/wix output.
    if (target === "dmg" && this.macos) {
      await signAndNotarizeMacOs(binaryPath, this.macos, nodeProcessRunner);
    }

    await generatePackageUseCase().execute({ target, config, binaryPath, outputDir: outDir });
    const built = await buildPackageUseCase().execute({ target, config, binaryPath, dir: join(outDir, target) });

    if (this.authenticode && AUTHENTICODE_TARGETS.includes(target)) {
      await signAuthenticode(built.outputPath, this.authenticode, nodeProcessRunner);
    }
    if (this.signingKey) {
      signFile(built.outputPath, this.signingKey.keyFile, this.signingKey.password);
    }

    const sha256 = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(built.outputPath).arrayBuffer())
      .digest("hex");

    return { target, path: built.outputPath, sha256 };
  }
}
