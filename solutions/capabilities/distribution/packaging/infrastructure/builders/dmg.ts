// Turning a DMG definition into a real .dmg, via appdmg.
//
// generateDMG() already returns the exact JSON `appdmg` (the npm CLI tool)
// takes as a spec file — title/icon/background/window/contents — unlike
// deb/appimage's ad-hoc envelopes. So, like nsis/wix, one missing piece was
// only writing it to disk and invoking the tool, not materializing a tree.
//
// The other missing piece — what used to be this file's KNOWN GAP note —
// was that `appPath` (what generateDMG's `contents` entry points at) was
// the raw runtime binary, not a proper `.app` bundle: macOS won't treat a
// bare Mach-O executable as a double-clickable app, LaunchServices needs
// the `Contents/{MacOS,Resources}` + `Info.plist` shape to know what it's
// looking at. That's what buildAppBundle assembles below, the same way
// deb.ts materializes a `pkgroot` tree before invoking dpkg-deb.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessRunner } from "@carbon/process";
import { generateDMG, generateInfoPlist } from "../generators/dmg.ts";
import type { PackageWriter } from "../../application/ports/PackageWriter.ts";

export interface BuildResult {
  readonly outputPath: string;
}

export class DmgBuildError extends Error {
  constructor(readonly code: number) {
    super(`appdmg exited with code ${code}`);
  }
}

/**
 * Assembles `{dir}/{AppName}.app` around the compiled binary and returns
 * its path. Mirrors deb.ts's pkgroot pattern: write the plist, copy the
 * binary in under the app's own name (not the build artifact's original
 * name — `carbon-mini` becomes `Contents/MacOS/<app.name>`, matching
 * CFBundleExecutable and how deb.ts renames the same binary for the same
 * reason), carry the bytecode bundle along if bundling produced one
 * (nsis.ts does the identical existsSync check for the same file).
 */
function buildAppBundle(config: CarbonConfig, binaryPath: string, dir: string, writer: PackageWriter): string {
  const appName = config.app.display_name || config.app.name;
  const appBundlePath = `${dir}/${appName}.app`;
  const contentsDir = `${appBundlePath}/Contents`;
  const macosDir = `${contentsDir}/MacOS`;
  const resourcesDir = `${contentsDir}/Resources`;

  writer.createDirectory(macosDir);
  writer.createDirectory(resourcesDir);
  writer.writeFile(`${contentsDir}/Info.plist`, generateInfoPlist(config, config.app.name));

  const installedBinary = `${macosDir}/${config.app.name}`;
  writer.copyFile(binaryPath, installedBinary);
  writer.makeExecutable(installedBinary);

  const bundlePath = join(dirname(binaryPath), "..", "dist", "bundle.qbc.zst");
  if (existsSync(bundlePath)) writer.copyFile(bundlePath, `${resourcesDir}/bundle.qbc.zst`);

  return appBundlePath;
}

export async function buildDmg(
  config: CarbonConfig,
  binaryPath: string,
  dir: string,
  writer: PackageWriter,
  runner: ProcessRunner,
): Promise<BuildResult> {
  const appBundlePath = buildAppBundle(config, binaryPath, dir, writer);

  const spec = await generateDMG(config, appBundlePath, dir);
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
