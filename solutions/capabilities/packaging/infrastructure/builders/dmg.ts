// Turning a DMG definition into a real .dmg, via appdmg.
//
// generateDMG() already returns the exact JSON `appdmg` (the npm CLI tool)
// takes as a spec file — title/icon/background/window/contents — unlike
// deb/appimage's ad-hoc envelopes. So, like nsis/wix, the missing piece was
// only writing it to disk and invoking the tool, not materializing a tree.
//
// KNOWN GAP: `appPath` (what generateDMG's `contents` entry points at) is
// the raw runtime binary today, not a proper .app bundle — no bundling step
// exists yet to wrap carbon-mini/carbon-blitz the way macOS expects a
// double-clickable app to look. The dmg builds; what's inside it isn't a
// real macOS app yet.

import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessRunner } from "@carbon/process";
import { generateDMG } from "../generators/dmg.ts";
import type { PackageWriter } from "../../application/ports/PackageWriter.ts";

export interface BuildResult {
  readonly outputPath: string;
}

export class DmgBuildError extends Error {
  constructor(readonly code: number) {
    super(`appdmg exited with code ${code}`);
  }
}

export async function buildDmg(
  config: CarbonConfig,
  binaryPath: string,
  dir: string,
  writer: PackageWriter,
  runner: ProcessRunner,
): Promise<BuildResult> {
  const spec = await generateDMG(config, binaryPath, dir);
  const specPath = `${dir}/spec.json`;
  writer.writeFile(specPath, spec);

  // Unlike deb.ts/appimage.ts, generateDMG()'s JSON has no outputFile field
  // — appdmg's spec format doesn't carry its own output path, only the
  // volume's title/contents. Same appName/version precedence generateDMG()
  // uses internally, so the two stay in agreement.
  const appName = config.app.display_name || config.app.name;
  const outputFile = `${dir}/${appName}-${config.app.version}.dmg`;

  const result = await runner.run("appdmg", [specPath, outputFile]);
  if (result.code !== 0) throw new DmgBuildError(result.code);

  return { outputPath: outputFile };
}
