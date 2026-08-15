// @carbon/packaging — an artifact into an OS installer definition.
//
//   application/ports/      PackageWriter — where a definition gets written
//   application/usecases/   GeneratePackageUseCase: target -> definition on disk
//   infrastructure/         NodePackageWriter, and generators/ — one per
//                           installer target
//
// ── WHAT IT PRODUCES ────────────────────────────────────────────────────────
// The INPUT a packaging tool consumes — an NSIS .nsi, a WiX .wxs, a Debian
// control file — not the installer binary. Producing that needs makensis, the
// WiX toolset or dpkg-deb installed, which is what `carbon doctor` checks.
//
// Until the use case existed these five generators were dead code: nothing
// called them, and `carbon bundle` reported what it would do without doing it.

export {
  GeneratePackageUseCase,
  UnknownTargetError,
  WrongPlatformError,
  type GeneratePackageRequest,
  type GeneratePackageResult,
} from "./application/usecases/GeneratePackageUseCase.ts";
export type { PackageWriter } from "./application/ports/PackageWriter.ts";
export { NodePackageWriter } from "./infrastructure/NodePackageWriter.ts";

export * from "./infrastructure/generators/appimage.ts";
export * from "./infrastructure/generators/deb.ts";
export * from "./infrastructure/generators/dmg.ts";
export * from "./infrastructure/generators/nsis.ts";
export * from "./infrastructure/generators/wix.ts";

import { GeneratePackageUseCase } from "./application/usecases/GeneratePackageUseCase.ts";
import { NodePackageWriter } from "./infrastructure/NodePackageWriter.ts";

/** The use case wired to the real filesystem. */
export function generatePackageUseCase(): GeneratePackageUseCase {
  return new GeneratePackageUseCase(new NodePackageWriter());
}
