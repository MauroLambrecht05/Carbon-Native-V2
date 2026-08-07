// @carbon/scaffolding — turning a name and a preset into a working project.
//
// Extracted from the CLI's `init` command, which had grown to a 532-line file
// holding fourteen embedded templates, the preset table, path arithmetic and
// eleven direct filesystem calls. None of that was CLI-specific: an editor
// plugin or a `carbon create` web flow needs exactly the same thing, and the
// command is now argv parsing plus output.
//
//   domain/          names, presets, the plan, and the errors
//   application/     CreateProjectUseCase, plus the ports it needs
//   infrastructure/  the embedded templates and the real filesystem

export { ProjectPlan, type PlannedFile } from "./domain/entities/ProjectPlan.ts";
export { ProjectName } from "./domain/value-objects/ProjectName.ts";
export {
  PRESETS,
  PRESET_NAMES,
  DEFAULT_PRESET,
  presetNamed,
  type Preset,
  type PresetName,
  type ManifestShape,
  type Styling,
} from "./domain/value-objects/Preset.ts";
export { packagesRelativeTo } from "./domain/value-objects/PackagesPath.ts";
export {
  ScaffoldError,
  UnknownPresetError,
  TargetNotEmptyError,
  OutsideWorkspaceError,
} from "./domain/errors/ScaffoldError.ts";

export type { ProjectFileSystem } from "./application/ports/ProjectFileSystem.ts";
export type { TemplateSource, TemplateRequest } from "./application/ports/TemplateSource.ts";
export {
  CreateProjectUseCase,
  type CreateProjectRequest,
  type CreateProjectResult,
} from "./application/usecases/CreateProjectUseCase.ts";

export { EmbeddedTemplateSource } from "./infrastructure/EmbeddedTemplateSource.ts";
export { NodeProjectFileSystem } from "./infrastructure/NodeProjectFileSystem.ts";

import { nodeProcessRunner } from "@carbon/process";
import { CreateProjectUseCase } from "./application/usecases/CreateProjectUseCase.ts";
import { EmbeddedTemplateSource } from "./infrastructure/EmbeddedTemplateSource.ts";
import { NodeProjectFileSystem } from "./infrastructure/NodeProjectFileSystem.ts";

/**
 * The use case wired to the real filesystem, the embedded templates and a real
 * subprocess runner.
 *
 * A convenience for callers that want the default behaviour — which is every
 * caller today. Anything needing different adapters constructs the use case
 * directly; this is not the only way in.
 */
export function createProjectUseCase(): CreateProjectUseCase {
  return new CreateProjectUseCase(
    new NodeProjectFileSystem(),
    new EmbeddedTemplateSource(),
    nodeProcessRunner,
  );
}
