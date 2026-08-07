// @carbon/plugins — authoring, building and installing native plugins.
//
// Extracted from the CLI's `plugin` command, which held 32 direct filesystem
// calls, a hand-rolled TOML line editor and the artifact-location rules in one
// 417-line file. None of it was CLI-specific: an editor extension installing a
// plugin needs exactly the same steps.
//
//   domain/          names, languages, the manifest, the [plugins] table
//   application/     one use case per operation, plus the ports they need
//   infrastructure/  the real filesystem and the SDK templates

export { PluginName } from "./domain/value-objects/PluginName.ts";
export {
  RUST,
  ZIG,
  LANGUAGES,
  languageNamed,
  type LanguageId,
  type PluginLanguage,
} from "./domain/value-objects/PluginLanguage.ts";
export { PluginManifest } from "./domain/entities/PluginManifest.ts";
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

export { NodePluginWorkspace } from "./infrastructure/NodePluginWorkspace.ts";
export { SdkTemplateSource, sdkRootFor } from "./infrastructure/SdkTemplateSource.ts";

import { nodeProcessRunner } from "@carbon/process";
import { BuildPluginUseCase } from "./application/usecases/BuildPluginUseCase.ts";
import { CreatePluginUseCase } from "./application/usecases/CreatePluginUseCase.ts";
import { InspectPluginsUseCase } from "./application/usecases/InspectPluginsUseCase.ts";
import { InstallPluginUseCase } from "./application/usecases/InstallPluginUseCase.ts";
import { NodePluginWorkspace } from "./infrastructure/NodePluginWorkspace.ts";
import { SdkTemplateSource, sdkRootFor } from "./infrastructure/SdkTemplateSource.ts";

/**
 * The use cases wired to the real filesystem, SDK and subprocess runner.
 *
 * One factory rather than four, because a caller doing plugin work generally
 * needs more than one of them and they must share a workspace adapter.
 */
export function pluginUseCases(workspaceRoot: string) {
  const workspace = new NodePluginWorkspace();
  const sdkRoot = sdkRootFor(workspaceRoot);

  return {
    workspace,
    sdkRoot,
    create: new CreatePluginUseCase(workspace, new SdkTemplateSource(workspace, sdkRoot)),
    build: new BuildPluginUseCase(workspace, nodeProcessRunner),
    install: new InstallPluginUseCase(workspace),
    inspect: new InspectPluginsUseCase(workspace),
  };
}
