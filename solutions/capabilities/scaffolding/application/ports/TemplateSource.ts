// Where a project's starting files come from.
//
// Behind a port because the use case should not know that templates are
// embedded strings with @@PLACEHOLDER@@ syntax. That is one possible source;
// a directory of user templates, or a remote starter, would be others, and
// none of them should change how a project is created.

import type { PlannedFile } from "../../domain/entities/ProjectPlan.ts";
import type { Preset } from "../../domain/value-objects/Preset.ts";
import type { ProjectName } from "../../domain/value-objects/ProjectName.ts";

export interface TemplateRequest {
  readonly name: ProjectName;
  readonly preset: Preset;
  /** Relative path from the project back to the workspace packages/ dir. */
  readonly packagesPath: string;
  /** Runtime backend to write into the manifest. */
  readonly backend: string;
}

export interface TemplateSource {
  /** The complete set of files, with placeholders already resolved. */
  filesFor(request: TemplateRequest): PlannedFile[];
}
