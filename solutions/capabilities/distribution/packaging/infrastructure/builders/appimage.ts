// Turning an AppImage definition into a real .AppImage, via appimagetool.
//
// generateAppImage() already describes the AppDir (the .desktop entry, the
// AppRun launcher script); this materializes that description into a real
// AppDir and invokes the tool that reads it.
//
// KNOWN GAP: appimagetool also wants an icon at the AppDir root (matching the
// desktop entry's Icon= line) or it warns and falls back to a generic one.
// No icon asset pipeline exists in this repo yet — the produced AppImage is
// valid but generic-icon until one does. Not blocking: it builds and runs.

import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessRunner } from "@carbon/process";
import { generateAppImage } from "../generators/appimage.ts";
import type { PackageWriter } from "../../application/ports/PackageWriter.ts";

export interface BuildResult {
  readonly outputPath: string;
}

export class AppImageBuildError extends Error {
  constructor(readonly code: number) {
    super(`appimagetool exited with code ${code}`);
  }
}

export async function buildAppImage(
  config: CarbonConfig,
  binaryPath: string,
  dir: string,
  writer: PackageWriter,
  runner: ProcessRunner,
): Promise<BuildResult> {
  const definition = JSON.parse(await generateAppImage(config, binaryPath, dir)) as {
    appDir: string;
    desktopFile: string;
    appRun: string;
    outputFile: string;
  };
  // Same precedence generateAppImage() uses internally for the entry's Name=
  // and the desktop filename appimagetool expects to find at the AppDir root.
  const appName = config.app.display_name || config.app.name;

  const appDirPath = `${dir}/${definition.appDir}`;
  const launcher = `${appDirPath}/usr/bin/launcher`;
  writer.copyFile(binaryPath, launcher);
  writer.makeExecutable(launcher);

  const appRunPath = `${appDirPath}/AppRun`;
  writer.writeFile(appRunPath, definition.appRun);
  writer.makeExecutable(appRunPath);

  writer.writeFile(`${appDirPath}/${appName}.desktop`, definition.desktopFile);

  const result = await runner.run("appimagetool", [appDirPath, definition.outputFile]);
  if (result.code !== 0) throw new AppImageBuildError(result.code);

  return { outputPath: definition.outputFile };
}
