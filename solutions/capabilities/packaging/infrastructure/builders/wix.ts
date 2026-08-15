// Turning a WiX definition into a real .msi, via the WiX v4 CLI (`wix
// build`). Like nsis.ts, generateWiX() already returns real .wxs XML — the
// missing piece was putting the binary beside it and invoking the toolset.

import { join } from "node:path";
import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessRunner } from "@carbon/process";
import { generateWiX } from "../generators/wix.ts";
import type { PackageWriter } from "../../application/ports/PackageWriter.ts";

export interface BuildResult {
  readonly outputPath: string;
}

export class WixBuildError extends Error {
  constructor(readonly code: number) {
    super(`wix build exited with code ${code}`);
  }
}

export async function buildWix(
  config: CarbonConfig,
  binaryPath: string,
  dir: string,
  writer: PackageWriter,
  runner: ProcessRunner,
): Promise<BuildResult> {
  const wxs = await generateWiX(config, binaryPath, dir);
  const wxsPath = `${dir}/installer.wxs`;
  writer.writeFile(wxsPath, wxs);
  writer.copyFile(binaryPath, join(dir, binaryPath.split(/[\\/]/).pop()!));

  const appName = config.app.display_name || config.app.name;
  const outputFile = `${dir}/${appName}-${config.app.version}.msi`;

  const result = await runner.run("wix", ["build", wxsPath, "-o", outputFile]);
  if (result.code !== 0) throw new WixBuildError(result.code);

  return { outputPath: outputFile };
}
