// Turning an NSIS definition into a real .exe, via makensis.
//
// Unlike deb/appimage, generateNSIS() already returns the real .nsi script
// text — no JSON envelope to unpack. What's missing is putting the files its
// `File` directives reference beside it and running makensis.
//
// KNOWN GAP: the script also does `File "launcher.exe"` — a small stub binary
// nothing in this repo builds yet (see the note in generators/nsis.ts's
// Section "Install"). Until something produces one, an NSIS build fails at
// makensis with "launcher.exe: file not found", not silently. binaryPath and
// the bytecode bundle (if present) ARE copied into place; that part is real.

import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import type { CarbonConfig } from "@carbon/contracts/app";
import type { ProcessRunner } from "@carbon/process";
import { generateNSIS } from "../generators/nsis.ts";
import type { PackageWriter } from "../../application/ports/PackageWriter.ts";

export interface BuildResult {
  readonly outputPath: string;
}

export class NsisBuildError extends Error {
  constructor(readonly code: number) {
    super(`makensis exited with code ${code}`);
  }
}

export async function buildNsis(
  config: CarbonConfig,
  binaryPath: string,
  dir: string,
  writer: PackageWriter,
  runner: ProcessRunner,
): Promise<BuildResult> {
  const script = await generateNSIS(config, binaryPath, dir);
  const scriptPath = `${dir}/installer.nsi`;
  writer.writeFile(scriptPath, script);

  // makensis resolves a bare `File "x"` against the .nsi's own directory.
  writer.copyFile(binaryPath, join(dir, binaryPath.split(/[\\/]/).pop()!));
  const bundlePath = join(dirname(binaryPath), "..", "dist", "bundle.qbc.zst");
  if (existsSync(bundlePath)) writer.copyFile(bundlePath, join(dir, "bundle.qbc.zst"));

  const appName = config.app.display_name || config.app.name;
  const outputFile = `${dir}/${appName}-${config.app.version}-setup.exe`;

  const result = await runner.run("makensis", [scriptPath]);
  if (result.code !== 0) throw new NsisBuildError(result.code);

  return { outputPath: outputFile };
}
