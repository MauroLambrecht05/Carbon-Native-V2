// Everything a new project consists of, before any of it is written.
//
// Scaffolding is decided in one place and performed in another. The use case
// produces a plan; infrastructure writes it. That means the interesting part —
// which files, with what contents, for which preset — is testable against a
// value, with no temporary directory and no cleanup, and a future `--dry-run`
// is a matter of not calling the writer.

import type { ProjectName } from "../value-objects/ProjectName.ts";
import type { Preset } from "../value-objects/Preset.ts";

export interface PlannedFile {
  /** Relative to the project root; never absolute. */
  readonly path: string;
  readonly contents: string;
}

export class ProjectPlan {
  constructor(
    /** Absolute directory the project will be created in. */
    readonly target: string,
    readonly name: ProjectName,
    readonly preset: Preset,
    readonly files: readonly PlannedFile[],
  ) {}

  /** Sorted, so assertions and any listing output are stable. */
  get paths(): string[] {
    return this.files.map((f) => f.path).sort();
  }

  fileAt(path: string): PlannedFile | undefined {
    return this.files.find((f) => f.path === path);
  }
}
