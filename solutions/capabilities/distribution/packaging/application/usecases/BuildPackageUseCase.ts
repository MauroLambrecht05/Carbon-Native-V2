// Turning a written installer definition into the real installer.
//
// GeneratePackageUseCase deliberately stops at the definition — see its own
// header comment. This is the next, separate step: invoking the toolchain
// (dpkg-deb, appimagetool, and eventually makensis/WiX/create-dmg) that turns
// that definition into a `.deb`/`.AppImage`/etc. Kept as its own use case
// rather than folded into GeneratePackageUseCase because the two have
// different preconditions — generation needs nothing but Node; building needs
// a real toolchain installed, which is true on a build worker and not
// generally true on a dev laptop.
//
// Every generator now has a real builder.

import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessRunner } from "@carbon/process";
import {
  installerTarget,
  isBuildableOn,
  type InstallerTarget,
  type InstallerTargetId,
} from "@carbon/contracts/distribution";
import type { PackageWriter } from "../ports/PackageWriter.ts";
import { buildAppImage } from "../../infrastructure/builders/appimage.ts";
import { buildDeb } from "../../infrastructure/builders/deb.ts";
import { buildNsis } from "../../infrastructure/builders/nsis.ts";
import { buildWix } from "../../infrastructure/builders/wix.ts";
import { buildDmg } from "../../infrastructure/builders/dmg.ts";
import { UnknownTargetError, WrongPlatformError } from "./GeneratePackageUseCase.ts";

type Builder = (
  config: CarbonConfig,
  binaryPath: string,
  dir: string,
  writer: PackageWriter,
  runner: ProcessRunner,
) => Promise<{ outputPath: string }>;

const BUILDERS: Partial<Record<InstallerTargetId, Builder>> = {
  deb: buildDeb,
  appimage: buildAppImage,
  nsis: buildNsis,
  wix: buildWix,
  dmg: buildDmg,
};

export class TargetNotBuildableError extends Error {
  constructor(readonly target: InstallerTargetId) {
    super(`${target} has a generator but no builder yet`);
  }
}

export interface BuildPackageRequest {
  readonly target: string;
  readonly config: CarbonConfig;
  /** The built runtime binary the installer wraps. */
  readonly binaryPath: string;
  /** The directory GeneratePackageUseCase already wrote the definition into. */
  readonly dir: string;
  readonly platform?: NodeJS.Platform;
}

export interface BuildPackageResult {
  readonly target: InstallerTarget;
  readonly outputPath: string;
}

export class BuildPackageUseCase {
  constructor(
    private readonly writer: PackageWriter,
    private readonly runner: ProcessRunner,
  ) {}

  /**
   * @throws UnknownTargetError | WrongPlatformError | TargetNotBuildableError
   */
  async execute(request: BuildPackageRequest): Promise<BuildPackageResult> {
    const target = installerTarget(request.target);
    if (!target) throw new UnknownTargetError(request.target);

    const platform = request.platform ?? process.platform;
    if (!isBuildableOn(target, platform)) {
      throw new WrongPlatformError(target, platform);
    }

    const build = BUILDERS[target.id];
    if (!build) throw new TargetNotBuildableError(target.id);

    const { outputPath } = await build(
      request.config,
      request.binaryPath,
      request.dir,
      this.writer,
      this.runner,
    );

    return { target, outputPath };
  }
}
