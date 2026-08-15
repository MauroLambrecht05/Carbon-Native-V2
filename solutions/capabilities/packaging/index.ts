// @carbon/packaging — an artifact into an OS installer.
//
//   application/ports/      PackageWriter — where a definition, and a package
//                           tree, get written
//   application/usecases/   GeneratePackageUseCase: target -> definition on disk
//                           BuildPackageUseCase: definition -> real installer
//   infrastructure/         NodePackageWriter, generators/ (one per target),
//                           builders/ (one per target with a real toolchain
//                           step — deb and appimage so far)
//
// ── GENERATE VS. BUILD ──────────────────────────────────────────────────────
// GeneratePackageUseCase writes the INPUT a packaging tool consumes — an NSIS
// .nsi, a WiX .wxs, a Debian control file — not the installer binary.
// BuildPackageUseCase is the separate step that actually invokes the
// toolchain (dpkg-deb, appimagetool today), because that needs a real
// toolchain installed and generation does not — true on a build worker, not
// generally true on a dev laptop. `carbon doctor` is what checks for the
// toolchain locally.
//
// Until GeneratePackageUseCase existed the five generators were dead code:
// nothing called them, and `carbon bundle` reported what it would do without
// doing it. BuildPackageUseCase closes the next gap the same way.

export {
  GeneratePackageUseCase,
  UnknownTargetError,
  WrongPlatformError,
  type GeneratePackageRequest,
  type GeneratePackageResult,
} from "./application/usecases/GeneratePackageUseCase.ts";
export {
  BuildPackageUseCase,
  TargetNotBuildableError,
  type BuildPackageRequest,
  type BuildPackageResult,
} from "./application/usecases/BuildPackageUseCase.ts";
export type { PackageWriter } from "./application/ports/PackageWriter.ts";
export { NodePackageWriter } from "./infrastructure/NodePackageWriter.ts";

export * from "./infrastructure/generators/appimage.ts";
export * from "./infrastructure/generators/deb.ts";
export * from "./infrastructure/generators/dmg.ts";
export * from "./infrastructure/generators/nsis.ts";
export * from "./infrastructure/generators/wix.ts";
export { buildDeb, DebBuildError } from "./infrastructure/builders/deb.ts";
export { buildAppImage, AppImageBuildError } from "./infrastructure/builders/appimage.ts";

import { nodeProcessRunner } from "@carbon/process";
import { GeneratePackageUseCase } from "./application/usecases/GeneratePackageUseCase.ts";
import { BuildPackageUseCase } from "./application/usecases/BuildPackageUseCase.ts";
import { NodePackageWriter } from "./infrastructure/NodePackageWriter.ts";

/** The use case wired to the real filesystem. */
export function generatePackageUseCase(): GeneratePackageUseCase {
  return new GeneratePackageUseCase(new NodePackageWriter());
}

/** The use case wired to the real filesystem and real subprocesses. */
export function buildPackageUseCase(): BuildPackageUseCase {
  return new BuildPackageUseCase(new NodePackageWriter(), nodeProcessRunner);
}
