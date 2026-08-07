// Scaffolding a project, end to end.
//
// Two halves, matching the use case: plan() is pure, so every preset is covered
// against values with no temp directory at all; execute() runs once against a
// real one to prove the plan reaches the disk intact.
//
// This is the layer that had no test before — the whole thing lived inside a
// CLI command, where the only way to check a preset was to run `carbon init`
// and look at the output.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "@carbon/process";
import {
  CreateProjectUseCase,
  EmbeddedTemplateSource,
  NodeProjectFileSystem,
  OutsideWorkspaceError,
  packagesRelativeTo,
  PRESET_NAMES,
  ProjectName,
  TargetNotEmptyError,
  UnknownPresetError,
  type PresetName,
  type ProjectFileSystem,
} from "../index.ts";

/** Records what would have been spawned, and never spawns it. */
class FakeProcessRunner implements ProcessRunner {
  readonly calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  constructor(private readonly code = 0) {}

  async run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
    this.calls.push({ command, args, options });
    return { code: this.code, signal: null };
  }
}

/** Answers "is it empty" without a disk. */
class FakeFileSystem implements ProjectFileSystem {
  constructor(private readonly empty = true) {}
  isEmptyDirectory(): boolean {
    return this.empty;
  }
  createDirectory(): void {}
  writeFile(): void {}
}

const ROOT = process.platform === "win32" ? "C:\\work\\carbon" : "/work/carbon";
const CWD = join(ROOT, "apps");

function useCaseWith(files: ProjectFileSystem, runner = new FakeProcessRunner()) {
  return new CreateProjectUseCase(files, new EmbeddedTemplateSource(), runner);
}

function planFor(preset: PresetName, name = "my-app") {
  return useCaseWith(new FakeFileSystem()).plan({
    name,
    cwd: CWD,
    workspaceRoot: ROOT,
    preset,
  });
}

describe("naming", () => {
  test("a display name is slugified, and titled back for the UI", () => {
    const name = ProjectName.from("My Cool App!!");
    expect(name.slug).toBe("my-cool-app");
    expect(name.display).toBe("My Cool App");
  });

  test("runs of punctuation collapse to a single hyphen", () => {
    expect(ProjectName.from("a -- b__c").slug).toBe("a-b-c");
  });

  test("a name with nothing usable in it still yields a directory name", () => {
    // Otherwise this scaffolds into "" — i.e. the parent directory.
    expect(ProjectName.from("!!!").slug).toBe("carbon-app");
  });
});

describe("every preset produces a coherent project", () => {
  for (const preset of PRESET_NAMES) {
    test(`${preset}: writes the same five files`, () => {
      expect(planFor(preset).paths).toEqual([
        ".gitignore",
        "App.tsx",
        "carbon.toml",
        "package.json",
        "tsconfig.json",
      ]);
    });

    test(`${preset}: the manifest and package.json carry the project name`, () => {
      const plan = planFor(preset, "My Cool App");
      expect(plan.fileAt("carbon.toml")!.contents).toContain('name = "my-cool-app"');
      expect(plan.fileAt("carbon.toml")!.contents).toContain('display_name = "My Cool App"');
      expect(plan.fileAt("package.json")!.contents).toContain('"name": "my-cool-app"');
    });

    test(`${preset}: no placeholder survives rendering`, () => {
      // A missed @@PLACEHOLDER@@ produces a project that looks fine until the
      // manifest is parsed, so check all of them, in every file.
      for (const file of planFor(preset).files) {
        expect(file.contents).not.toMatch(/@@[A-Z]+@@/);
      }
    });

    test(`${preset}: the runtime dependency is pinned`, () => {
      expect(planFor(preset).fileAt("package.json")!.contents).toContain("@carbon/mini-solid");
    });
  }

  test("tailwind presets get the tailwind plugin and class-based JSX", () => {
    const plan = planFor("tailwind");
    expect(plan.fileAt("carbon.toml")!.contents).toContain("[tailwind]");
    expect(plan.fileAt("package.json")!.contents).toContain("@carbon/vite/tailwind");
    expect(plan.fileAt("App.tsx")!.contents).toContain('class="p-7');
  });

  test("blank presets get neither — inline styles work with no plugin", () => {
    const plan = planFor("blank");
    expect(plan.fileAt("carbon.toml")!.contents).not.toContain("[tailwind]");
    expect(plan.fileAt("package.json")!.contents).not.toContain("tailwindcss");
    expect(plan.fileAt("App.tsx")!.contents).toContain("style={{");
  });

  test("three gets the gpu canvas plugin declared", () => {
    const plan = planFor("three");
    expect(plan.fileAt("carbon.toml")!.contents).toContain("[runtime.plugins]");
    expect(plan.fileAt("carbon.toml")!.contents).toContain('capabilities = ["gpu"]');
    expect(plan.fileAt("package.json")!.contents).toContain('"three"');
  });

  test("the App.tsx comment keeps its backticks", () => {
    // The template is a template literal containing escaped backticks. Getting
    // that wrong emits a literal backslash into every scaffolded project.
    const app = planFor("blank").fileAt("App.tsx")!.contents;
    expect(app).toContain("`carbon dev`");
    expect(app).not.toContain("\\`");
  });
});

describe("the backend flag reaches the manifest", () => {
  test("the default is mini", () => {
    expect(planFor("blank").fileAt("carbon.toml")!.contents).toContain('backend = "mini"');
  });

  test("an explicit backend replaces it", () => {
    const plan = useCaseWith(new FakeFileSystem()).plan({
      name: "app",
      cwd: CWD,
      workspaceRoot: ROOT,
      backend: "blitz",
    });
    const manifest = plan.fileAt("carbon.toml")!.contents;
    expect(manifest).toContain('backend = "blitz"');
    expect(manifest).not.toContain('backend = "mini"');
  });
});

describe("refusals", () => {
  test("an unknown preset names the ones that exist", () => {
    expect(() => planFor("tailwnid" as PresetName)).toThrow(UnknownPresetError);
    // It used to fall through to "blank", scaffolding the wrong stack silently.
    expect(() => planFor("tailwnid" as PresetName)).toThrow(/--list-presets/);
  });

  test("a non-empty target is refused", () => {
    const useCase = useCaseWith(new FakeFileSystem(false));
    expect(() => useCase.plan({ name: "app", cwd: CWD, workspaceRoot: ROOT })).toThrow(
      TargetNotEmptyError,
    );
  });

  test("a target outside the workspace is refused, with the reason", () => {
    const useCase = useCaseWith(new FakeFileSystem());
    expect(() =>
      useCase.plan({
        name: "app",
        cwd: process.platform === "win32" ? "D:\\elsewhere" : "/elsewhere",
        workspaceRoot: ROOT,
      }),
    ).toThrow(OutsideWorkspaceError);
  });
});

describe("the packages path", () => {
  test("counts one level up per directory below the root", () => {
    expect(packagesRelativeTo(join(ROOT, "apps", "demo"), ROOT)).toBe("../../packages");
  });

  test("the root itself is ./packages", () => {
    expect(packagesRelativeTo(ROOT, ROOT)).toBe("./packages");
  });

  test("compares case-insensitively, because Windows paths do", () => {
    expect(packagesRelativeTo(join(ROOT.toUpperCase(), "demo"), ROOT)).toBe("../packages");
  });

  test("a sibling path deep enough to look plausible is still outside", () => {
    // Deeper than the root, so it gets past the length check and has to be
    // caught by the prefix comparison.
    expect(() => packagesRelativeTo("/somewhere/else/much/deeper", ROOT)).toThrow(/not inside/);
  });

  test("a path shallower than the root is rejected on its own terms", () => {
    expect(() => packagesRelativeTo("/tmp", ROOT)).toThrow(/shallower/);
  });
});

describe("writing to a real filesystem", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "carbon-scaffold-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("the plan lands on disk, and the install is run in the new project", async () => {
    const runner = new FakeProcessRunner();
    const useCase = new CreateProjectUseCase(
      new NodeProjectFileSystem(),
      new EmbeddedTemplateSource(),
      runner,
    );

    const { plan, installExitCode } = await useCase.execute({
      name: "Real Project",
      cwd: root,
      workspaceRoot: root,
      preset: "tailwind",
    });

    expect(plan.target).toBe(join(root, "real-project"));
    for (const path of plan.paths) {
      expect(existsSync(join(plan.target, path))).toBe(true);
    }
    expect(readFileSync(join(plan.target, "carbon.toml"), "utf8")).toContain(
      'name = "real-project"',
    );

    expect(installExitCode).toBe(0);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].command).toBe("bun");
    expect(runner.calls[0].args).toEqual(["install"]);
    // Installing in the wrong cwd is how you corrupt the parent workspace.
    expect(runner.calls[0].options?.cwd).toBe(plan.target);
  });

  test("--no-install skips the package manager entirely", async () => {
    const runner = new FakeProcessRunner();
    const useCase = new CreateProjectUseCase(
      new NodeProjectFileSystem(),
      new EmbeddedTemplateSource(),
      runner,
    );

    const { installExitCode } = await useCase.execute({
      name: "no-install",
      cwd: root,
      workspaceRoot: root,
      install: false,
    });

    expect(installExitCode).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  test("a failing install is reported, not thrown — the project is still there", async () => {
    const runner = new FakeProcessRunner(1);
    const useCase = new CreateProjectUseCase(
      new NodeProjectFileSystem(),
      new EmbeddedTemplateSource(),
      runner,
    );

    // This is the live behaviour: the templates pin @carbon/mini-solid into a
    // packages/ directory that has not existed since V1, so `bun install` does
    // fail. Scaffolding still has to leave a complete project behind.
    const { plan, installExitCode } = await useCase.execute({
      name: "install-fails",
      cwd: root,
      workspaceRoot: root,
    });

    expect(installExitCode).toBe(1);
    expect(existsSync(join(plan.target, "App.tsx"))).toBe(true);
  });

  test("an existing non-empty directory is refused before anything is written", async () => {
    const occupied = join(root, "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "important.txt"), "do not clobber me");

    const useCase = new CreateProjectUseCase(
      new NodeProjectFileSystem(),
      new EmbeddedTemplateSource(),
      new FakeProcessRunner(),
    );

    await expect(
      useCase.execute({ name: "occupied", cwd: root, workspaceRoot: root }),
    ).rejects.toThrow(TargetNotEmptyError);

    expect(readFileSync(join(occupied, "important.txt"), "utf8")).toBe("do not clobber me");
  });
});
