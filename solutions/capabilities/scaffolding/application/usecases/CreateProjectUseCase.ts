// Creating a new project.
//
// Two steps, deliberately separable: plan(), which is pure and decides every
// file, and execute(), which writes the plan and optionally installs. A caller
// that wants a dry run calls plan() and stops; the tests do exactly that for
// everything except the writing itself.
//
// The dependency install lives here rather than in the CLI because it is part
// of what "create a project" means — a scaffold you cannot run is half a
// project. It goes through the ProcessRunner port, so what gets spawned is
// assertable without a package manager installed.

import { resolve } from "node:path";
import type { ProcessRunner } from "@carbon/process";
import { ProjectPlan } from "../../domain/entities/ProjectPlan.ts";
import { TargetNotEmptyError, OutsideWorkspaceError } from "../../domain/errors/ScaffoldError.ts";
import { packagesRelativeTo } from "../../domain/value-objects/PackagesPath.ts";
import { presetNamed, DEFAULT_PRESET } from "../../domain/value-objects/Preset.ts";
import { ProjectName } from "../../domain/value-objects/ProjectName.ts";
import type { ProjectFileSystem } from "../ports/ProjectFileSystem.ts";
import type { TemplateSource } from "../ports/TemplateSource.ts";

export interface CreateProjectRequest {
  /** What the user typed. Slugified into a directory name. */
  readonly name: string;
  /** Scaffold into `cwd` itself instead of a subdirectory. */
  readonly here?: boolean;
  readonly cwd: string;
  /** Absolute path to the carbon workspace root. */
  readonly workspaceRoot: string;
  readonly preset?: string;
  readonly backend?: string;
  /** Run the package manager once files are written. Default true. */
  readonly install?: boolean;
}

export interface CreateProjectResult {
  readonly plan: ProjectPlan;
  /** Wall-clock time to write the files, excluding any install. */
  readonly scaffoldMs: number;
  /** Exit code of the install, or null when it was skipped. */
  readonly installExitCode: number | null;
}

export class CreateProjectUseCase {
  constructor(
    private readonly files: ProjectFileSystem,
    private readonly templates: TemplateSource,
    private readonly processes: ProcessRunner,
  ) {}

  /**
   * Decides every file, without touching the disk beyond the emptiness check.
   *
   * @throws UnknownPresetError | TargetNotEmptyError | OutsideWorkspaceError
   */
  plan(request: CreateProjectRequest): ProjectPlan {
    const preset = presetNamed(request.preset ?? DEFAULT_PRESET);
    const name = ProjectName.from(request.name);
    const target = request.here ? request.cwd : resolve(request.cwd, name.slug);

    if (!this.files.isEmptyDirectory(target)) {
      throw new TargetNotEmptyError(target);
    }

    let packagesPath: string;
    try {
      packagesPath = packagesRelativeTo(target, request.workspaceRoot);
    } catch (e) {
      throw new OutsideWorkspaceError(
        target,
        request.workspaceRoot,
        e instanceof Error ? e.message : String(e),
      );
    }

    const files = this.templates.filesFor({
      name,
      preset,
      packagesPath,
      backend: request.backend ?? "mini",
    });

    return new ProjectPlan(target, name, preset, files);
  }

  async execute(request: CreateProjectRequest): Promise<CreateProjectResult> {
    const plan = this.plan(request);

    const started = performance.now();
    this.files.createDirectory(plan.target);
    for (const file of plan.files) {
      this.files.writeFile(resolve(plan.target, file.path), file.contents);
    }
    const scaffoldMs = performance.now() - started;

    let installExitCode: number | null = null;
    if (request.install ?? true) {
      // NOTE: this currently fails to resolve @carbon/mini-solid, because the
      // templates pin it into a packages/ directory that has not existed since
      // V1 — see domain/value-objects/PackagesPath.ts. The non-zero code is
      // reported rather than thrown: the project itself is scaffolded fine, and
      // the user can install by hand once the dependency is published.
      const result = await this.processes.run("bun", ["install"], {
        cwd: plan.target,
        stdio: "inherit",
      });
      installExitCode = result.code;
    }

    return { plan, scaffoldMs, installExitCode };
  }
}
