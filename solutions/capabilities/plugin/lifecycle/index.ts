// @carbon/plugin — authoring, building and installing native plugins.
//
// Extracted from the CLI's `plugin` command, which held 32 direct filesystem
// calls, a hand-rolled TOML line editor and the artifact-location rules in one
// 417-line file. None of it was CLI-specific: an editor extension installing a
// plugin needs exactly the same steps.
//
//   domain/          names, the language, the manifest, the [plugins] table
//   application/     one use case per operation, plus the ports they need
//   infrastructure/  the real filesystem and the SDK templates
//
// Two of the use cases exist purely to move a failure earlier. `check` reads a
// plugin's manifest against the extension-point registry; `preflight` reads an
// app's [plugins] table the same way, and `carbon run` calls it before
// launching. Everything they report the runtime would also report — on stderr,
// after the window is up, next to nothing that says which file to edit.

export { PluginName } from "./domain/value-objects/PluginName.ts";
export {
  ZIG,
  LANGUAGES,
  DEFAULT_LANGUAGE,
  languageNamed,
  type LanguageId,
  type PluginLanguage,
} from "./domain/value-objects/PluginLanguage.ts";
export { PluginManifest } from "./domain/entities/PluginManifest.ts";
export {
  parsePluginDeclaration,
  type PluginDeclaration,
} from "./domain/entities/PluginDeclaration.ts";
export {
  readPluginEntries,
  upsertPluginEntry,
  type PluginEntry,
} from "./domain/services/PluginsSection.ts";
export {
  PluginError,
  UnknownLanguageError,
  TargetNotEmptyError,
  NotAPluginDirectoryError,
  ArtifactNotFoundError,
  NoHostAppError,
  PluginNotFoundError,
} from "./domain/errors/PluginError.ts";

export type {
  PluginWorkspace,
  PluginTemplateSource,
  PluginTemplateRequest,
  PluginTemplateFile,
} from "./application/ports/PluginWorkspace.ts";
export {
  CreatePluginUseCase,
  forwardSlashes,
  type CreatePluginRequest,
  type CreatePluginResult,
} from "./application/usecases/CreatePluginUseCase.ts";
export {
  BuildPluginUseCase,
  type BuildPluginRequest,
  type BuildPluginResult,
} from "./application/usecases/BuildPluginUseCase.ts";
export {
  InstallPluginUseCase,
  type InstallPluginRequest,
  type InstallPluginResult,
  type LocatedArtifact,
} from "./application/usecases/InstallPluginUseCase.ts";
export {
  InspectPluginsUseCase,
  type InstalledPlugin,
  type PluginDetails,
} from "./application/usecases/InspectPluginsUseCase.ts";
export {
  CheckPluginUseCase,
  type CheckFinding,
  type CheckPluginResult,
  type FindingSeverity,
} from "./application/usecases/CheckPluginUseCase.ts";
export {
  PreflightPluginsUseCase,
  type PluginProblem,
  type PreflightResult,
} from "./application/usecases/PreflightPluginsUseCase.ts";
export {
  SyncLocalPluginsUseCase,
  type SyncedLocalPlugin,
  type SyncLocalPluginsResult,
} from "./application/usecases/SyncLocalPluginsUseCase.ts";

export { NodePluginWorkspace } from "./infrastructure/NodePluginWorkspace.ts";
export { SdkTemplateSource } from "./infrastructure/SdkTemplateSource.ts";
export { signStandardPluginArtifact, MissingSigningKeyError } from "./infrastructure/PluginSigner.ts";

import { nodeProcessRunner } from "@carbon/process";
import { BuildPluginUseCase } from "./application/usecases/BuildPluginUseCase.ts";
import { CheckPluginUseCase } from "./application/usecases/CheckPluginUseCase.ts";
import { PreflightPluginsUseCase } from "./application/usecases/PreflightPluginsUseCase.ts";
import { CreatePluginUseCase } from "./application/usecases/CreatePluginUseCase.ts";
import { InspectPluginsUseCase } from "./application/usecases/InspectPluginsUseCase.ts";
import { InstallPluginUseCase } from "./application/usecases/InstallPluginUseCase.ts";
import { SyncLocalPluginsUseCase } from "./application/usecases/SyncLocalPluginsUseCase.ts";
import { NodePluginWorkspace } from "./infrastructure/NodePluginWorkspace.ts";
import { SdkTemplateSource } from "./infrastructure/SdkTemplateSource.ts";

/**
 * The use cases wired to the real filesystem, SDK and subprocess runner.
 *
 * One factory rather than four, because a caller doing plugin work generally
 * needs more than one of them and they must share a workspace adapter.
 *
 * `sdkRoot` is a parameter rather than something this derives: the SDK is
 * `products/carbon-ext`, and a solution may not name a path inside a product.
 * The caller — carbon-cli — knows where its own products are.
 */
export function pluginUseCases(sdkRoot: string) {
  const workspace = new NodePluginWorkspace();

  const build = new BuildPluginUseCase(workspace, nodeProcessRunner);
  const install = new InstallPluginUseCase(workspace);

  return {
    workspace,
    sdkRoot,
    create: new CreatePluginUseCase(workspace, new SdkTemplateSource(workspace, sdkRoot)),
    build,
    install,
    inspect: new InspectPluginsUseCase(workspace),
    check: new CheckPluginUseCase(workspace),
    preflight: new PreflightPluginsUseCase(workspace),
    syncLocal: new SyncLocalPluginsUseCase(workspace, build, install),
  };
}
