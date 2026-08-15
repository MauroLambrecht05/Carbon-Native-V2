// Turning a DEB definition into a real .deb, via dpkg-deb.
//
// generateDEB() already describes the package (control file text, maintainer
// scripts, where the binary goes); this is the step that was missing —
// materializing that description into a real package tree and invoking the
// tool that reads it. A build worker, unlike a dev laptop, can assume
// dpkg-deb is installed (`carbon doctor` is what checks for it locally).

import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessRunner } from "@carbon/process";
import { generateDEB } from "../generators/deb.ts";
import type { PackageWriter } from "../../application/ports/PackageWriter.ts";

export interface BuildResult {
  readonly outputPath: string;
}

export class DebBuildError extends Error {
  constructor(readonly code: number) {
    super(`dpkg-deb exited with code ${code}`);
  }
}

export async function buildDeb(
  config: CarbonConfig,
  binaryPath: string,
  dir: string,
  writer: PackageWriter,
  runner: ProcessRunner,
): Promise<BuildResult> {
  const definition = JSON.parse(await generateDEB(config, binaryPath, dir)) as {
    packageName: string;
    control: string;
    preinst: string;
    postinst: string;
    prerm: string;
    postrm: string;
    binDir: string;
    outputFile: string;
  };

  // dpkg-deb reads this exact layout: DEBIAN/control beside DEBIAN/<script>,
  // and the payload rooted at the same directory as if it were "/".
  const pkgRoot = `${dir}/pkgroot`;
  writer.writeFile(`${pkgRoot}/DEBIAN/control`, definition.control);
  for (const script of ["preinst", "postinst", "prerm", "postrm"] as const) {
    const path = `${pkgRoot}/DEBIAN/${script}`;
    writer.writeFile(path, definition[script]);
    writer.makeExecutable(path);
  }

  const installedBinary = `${pkgRoot}/${definition.binDir}/${definition.packageName}`;
  writer.copyFile(binaryPath, installedBinary);
  writer.makeExecutable(installedBinary);

  const result = await runner.run("dpkg-deb", [
    "--build",
    "--root-owner-group",
    pkgRoot,
    definition.outputFile,
  ]);
  if (result.code !== 0) throw new DebBuildError(result.code);

  return { outputPath: definition.outputFile };
}
