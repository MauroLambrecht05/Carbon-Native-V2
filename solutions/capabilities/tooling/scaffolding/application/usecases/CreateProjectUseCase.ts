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
import { TargetNotEmptyError } from "../../domain/errors/ScaffoldError.ts";
import { workspacePathFrom } from "../../domain/value-objects/PackagesPath.ts";
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
   * A target outside the workspace is not refused: workspacePathFrom() falls
   * back to an absolute path ("standalone mode") since no generated file
   * depends on the workspace being an ancestor of the project anymore.
   *
   * @throws UnknownPresetError | TargetNotEmptyError
   */
  plan(request: CreateProjectRequest): ProjectPlan {
    const preset = presetNamed(request.preset ?? DEFAULT_PRESET);
    const name = ProjectName.from(request.name);
    const target = request.here ? request.cwd : resolve(request.cwd, name.slug);

    if (!this.files.isEmptyDirectory(target)) {
      throw new TargetNotEmptyError(target);
    }

    const workspacePath = workspacePathFrom(target, request.workspaceRoot);

    const files = this.templates.filesFor({
      name,
      preset,
      packagesPath: workspacePath.path,
      packagesPathKind: workspacePath.kind,
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
      // A non-zero code is reported rather than thrown. The project is
      // scaffolded either way, and an install can fail for reasons that have
      // nothing to do with the scaffold — no network, a registry outage — where
      // deleting the project would be the wrong response.
      // --linker=isolated, explicitly. A scaffolded project sits inside this
      // workspace but has its own directory, and bunfig is found by walking up
      // from the CWD — it would reach the repository root, where there is no
      // bunfig, not .config/. Without the flag a `file:` dependency fails with
      // EPERM against the root's node_modules junction. See .config/bunfig.toml.
      const result = await this.processes.run("bun", ["install", "--linker=isolated"], {
        cwd: plan.target,
        stdio: "inherit",
      });
      installExitCode = result.code;
    }

    return { plan, scaffoldMs, installExitCode };
  }
}
