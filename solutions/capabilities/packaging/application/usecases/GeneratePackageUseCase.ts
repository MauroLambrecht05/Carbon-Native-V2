// Producing an installer definition for one target.
//
// ── WHAT THESE GENERATORS ACTUALLY DO ───────────────────────────────────────
// They emit the INPUT a packaging tool consumes — an NSIS `.nsi` script, a WiX
// `.wxs` document, a Debian `control` file — not the installer itself. Turning
// that input into a `.exe`/`.msi`/`.deb` needs makensis, the WiX toolset or
// dpkg-deb on the machine, which `carbon doctor` is what checks for.
//
// That distinction is why this use case writes a file and stops. Claiming to
// have "built an installer" when what exists is a script would be the same
// dishonesty `carbon bundle` had before it said "would build".
//
// Before this existed the generators were dead code: five files nothing called,
// while the command reported what it would do. The capability had an
// implementation and no way in.

import type { CarbonConfig } from "@carbon/contracts/app";
import {
  installerTarget,
  isBuildableOn,
  type InstallerTarget,
  type InstallerTargetId,
} from "@carbon/contracts/distribution";
import type { PackageWriter } from "../ports/PackageWriter.ts";
import { generateAppImage } from "../../infrastructure/generators/appimage.ts";
import { generateDEB } from "../../infrastructure/generators/deb.ts";
import { generateDMG } from "../../infrastructure/generators/dmg.ts";
import { generateNSIS } from "../../infrastructure/generators/nsis.ts";
import { generateWiX } from "../../infrastructure/generators/wix.ts";

type Generator = (
  config: CarbonConfig,
  binaryPath: string,
  outputDir: string,
) => Promise<string>;

/**
 * Target -> the generator and the filename its tool expects.
 *
 * The filenames are not arbitrary: `makensis installer.nsi`, `wix build
 * installer.wxs`, and dpkg reads `DEBIAN/control` by that exact name. Getting
 * one wrong produces a file the tool will not look at.
 */
const GENERATORS: Record<InstallerTargetId, { generate: Generator; filename: string }> = {
  nsis: { generate: generateNSIS, filename: "installer.nsi" },
  wix: { generate: generateWiX, filename: "installer.wxs" },
  dmg: { generate: generateDMG, filename: "create-dmg.sh" },
  appimage: { generate: generateAppImage, filename: "AppRun" },
  deb: { generate: generateDEB, filename: "control" },
};

export class UnknownTargetError extends Error {
  constructor(readonly requested: string) {
    super(`unknown installer target "${requested}"`);
  }
}

export class WrongPlatformError extends Error {
  constructor(readonly target: InstallerTarget, readonly platform: string) {
    super(`${target.id} can only be built on ${target.platform}, not ${platform}`);
  }
}

export interface GeneratePackageRequest {
  readonly target: string;
  readonly config: CarbonConfig;
  /** The built runtime binary the installer will wrap. */
  readonly binaryPath: string;
  /** Root of the output tree; each target gets a subdirectory. */
  readonly outputDir: string;
  readonly platform?: NodeJS.Platform;
}

export interface GeneratePackageResult {
  readonly target: InstallerTarget;
  /** Where the definition was written. */
  readonly path: string;
  readonly bytes: number;
}

export class GeneratePackageUseCase {
  constructor(private readonly writer: PackageWriter) {}

  /**
   * @throws UnknownTargetError | WrongPlatformError
   */
  async execute(request: GeneratePackageRequest): Promise<GeneratePackageResult> {
    const target = installerTarget(request.target);
    if (!target) throw new UnknownTargetError(request.target);

    const platform = request.platform ?? process.platform;
    if (!isBuildableOn(target, platform)) {
      throw new WrongPlatformError(target, platform);
    }

    // Each target gets its own directory: dmg and appimage both emit more than
    // one file in a complete setup, and a flat output would collide.
    const dir = `${request.outputDir}/${target.id}`;
    this.writer.createDirectory(dir);

    const { generate, filename } = GENERATORS[target.id];
    const contents = await generate(request.config, request.binaryPath, dir);

    const path = `${dir}/${filename}`;
    this.writer.writeFile(path, contents);

    return { target, path, bytes: contents.length };
  }
}
