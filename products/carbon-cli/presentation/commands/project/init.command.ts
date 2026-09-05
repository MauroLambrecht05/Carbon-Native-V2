// `carbon init [name]` — scaffold a new project.
//
// Interactive by default: prompts for project name, then renderer (Solid /
// React), then stack (blank / tailwind / tailwind-plugins). Falls back to
// flags when stdin is not a TTY (CI, pipes) or when --yes / --preset are
// supplied directly.
//
// Everything that decides what a project consists of lives in @carbon/scaffolding.
// This file is the driving adapter: collect input, call one use case, print result.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  Command,
  EXIT_OK,
  EXIT_USAGE,
  type CommandMeta,
  type CommandContext,
  type ExitCode,
} from "@carbon/cli";
import type { Wizard } from "@carbon/cli";
import {
  createProjectUseCase,
  MENU_PRESETS,
  PRESET_NAMES,
  DEFAULT_PRESET,
  ScaffoldError,
  TargetNotEmptyError,
  type CreateProjectRequest,
  type CreateProjectResult,
  type Renderer,
} from "@carbon/scaffolding";
import { CARBON_ROOT } from "@carbon/workspace";
import { run } from "@carbon/process";

export class InitCommand extends Command {
  readonly meta: CommandMeta = {
    name: "init",
    aliases: ["new"],
    summary: "Scaffold a new project",
    usage: "init [name] [options]",
    flags: [
      {
        name: "preset",
        placeholder: "<preset>",
        description: PRESET_NAMES.join(" | "),
        default: DEFAULT_PRESET,
      },
      { name: "backend",       placeholder: "<backend>", description: "Runtime backend", default: "mini" },
      { name: "here",          boolean: true, description: "Scaffold into the current directory" },
      { name: "no-install",    boolean: true, description: "Skip bun install" },
      { name: "run",           boolean: true, description: "Start carbon dev once scaffolded" },
      { name: "list-presets",  boolean: true, description: "Show available presets and exit" },
      {
        name: "template",
        placeholder: "<id>",
        description: "Scaffold from a production template (tray-daemon | database-studio | realtime-chat | audio-station)",
      },
      { name: "list-templates", boolean: true, description: "Show available production templates and exit" },
      { name: "yes",           boolean: true, description: "Accept all defaults without prompting" },
    ],
    examples: [
      "carbon init",
      "carbon init my-app",
      "carbon init my-app --preset react-tailwind",
      "carbon init my-app --template tray-daemon",
      "carbon init my-app --yes",
    ],
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (ctx.flags.has("list-presets")) {
      this.listPresets(ctx);
      return EXIT_OK;
    }

    if (ctx.flags.has("list-templates")) {
      const { TemplateRegistry } = await import("../../../../carbon-templates/infrastructure/services/TemplateRegistry.ts");
      const templates = TemplateRegistry.getInstance().list();
      ctx.io.raw("\nAvailable Production Templates:\n");
      for (const t of templates) {
        ctx.io.raw(`  • ${ctx.io.c.bold(t.id.padEnd(18))} ${t.name} ${ctx.io.c.dim(`(${t.category})`)}`);
        ctx.io.raw(`    ${t.description}\n`);
      }
      return EXIT_OK;
    }

    if (ctx.flags.has("template")) {
      const templateId = ctx.flags.get("template")!;
      const name =
        ctx.first && ctx.first !== "."
          ? ctx.first
          : ctx.flags.has("here")
            ? basenameOf(ctx.cwd) ?? "my-app"
            : "my-app";
      const targetDir =
        ctx.first && ctx.first !== "." && !ctx.flags.has("here") ? join(ctx.cwd, name) : ctx.cwd;

      const { ScaffolderEngine } = await import(
        "../../../../carbon-templates/infrastructure/services/ScaffolderEngine.ts"
      );
      try {
        const result = await ScaffolderEngine.getInstance().scaffold({
          templateId,
          targetDir,
          appName: name,
        });

        ctx.io.success(`Project ${ctx.io.c.bold(name)} scaffolded from ${ctx.io.c.green(result.templateName)}!`);
        ctx.io.info(`Created ${result.createdFiles.length} files in ${targetDir}`);
        ctx.io.raw(`\nNext steps:\n  cd ${name}\n  carbon dev\n`);
        return EXIT_OK;
      } catch (err: any) {
        ctx.io.error(err.message);
        return EXIT_FAILURE;
      }
    }

    const interactive = !ctx.flags.has("yes") && ctx.io.isInteractive();

    // "." as a positional arg is shorthand for --here (scaffold into cwd).
    const firstArg = ctx.first;
    let useHere = ctx.flags.has("here");
    if (firstArg === ".") useHere = true;
    const nameGiven = !!(firstArg && firstArg !== ".");
    const hereName = useHere ? basenameOf(ctx.cwd) : undefined;

    const presetExplicit = ctx.argv.some(
      (a) => a === "--preset" || a.startsWith("--preset="),
    );

    // Which steps will actually need asking — computed up front so the
    // wizard's progress dots match what's really about to happen, rather
    // than always showing 3 steps and silently skipping one.
    const needsNameStep = interactive && !nameGiven && !hereName;
    const needsPresetSteps = interactive && !presetExplicit;
    const wizardSteps: string[] = [];
    if (needsNameStep) wizardSteps.push("name");
    if (needsPresetSteps) wizardSteps.push("renderer", "stack");
    const wizard = wizardSteps.length ? ctx.io.startWizard("carbon init", wizardSteps) : null;

    // ── Step 1: project name ─────────────────────────────────────────────────

    let resolvedName: string;
    {
      let name: string | undefined = nameGiven ? firstArg : hereName;

      if (!name) {
        if (!interactive) {
          ctx.io.error("init requires a project name. Try: carbon init my-app");
          return EXIT_USAGE;
        }
        const answered = await wizard!.text("Project name", "my-app");
        if (!answered) {
          ctx.io.error("A project name is required.");
          return EXIT_USAGE;
        }
        // "." means scaffold into the current directory — treat like --here
        if (answered === ".") {
          useHere = true;
          name = basenameOf(ctx.cwd) ?? "my-app";
        } else {
          name = answered;
        }
      }
      resolvedName = name;
    }

    // ── Step 2: preset ───────────────────────────────────────────────────────

    let preset: string;

    if (presetExplicit) {
      preset = ctx.flags.get("preset", DEFAULT_PRESET) ?? DEFAULT_PRESET;
    } else if (!interactive) {
      preset = DEFAULT_PRESET;
    } else {
      preset = await this.pickPreset(wizard!);
    }

    // ── Step 3: scaffold ─────────────────────────────────────────────────────

    const request: CreateProjectRequest = {
      name:          resolvedName,
      here:          useHere,
      cwd:           ctx.cwd,
      workspaceRoot: CARBON_ROOT,
      preset,
      backend:       ctx.flags.get("backend", "mini") ?? "mini",
      install:       !ctx.flags.has("no-install"),
    };

    const result = await this.scaffold(ctx, request, interactive);
    if (!result) return EXIT_USAGE;

    const { plan, scaffoldMs, installExitCode } = result;

    // Standalone-mode notice.
    const targetIsOutside = !plan.target
      .toLowerCase()
      .startsWith(CARBON_ROOT.toLowerCase());
    if (targetIsOutside) {
      ctx.io.warn(
        `standalone mode — tsconfig paths point at the carbon workspace at ` +
          `${ctx.io.c.dim(CARBON_ROOT)}. ` +
          `If you move that workspace, re-run ${ctx.io.c.bold("carbon init")} to regenerate the project.`,
      );
    }

    ctx.io.step(
      `${ctx.io.c.bold(plan.name.slug)} scaffolded with preset ` +
        `${ctx.io.c.bold(plan.preset.name)} in ${ctx.io.c.dim(plan.target)} ` +
        `(${scaffoldMs.toFixed(1)} ms)`,
    );

    if (installExitCode !== null && installExitCode !== 0) {
      ctx.io.warn(`bun install exited ${installExitCode} — you may need to run it manually`);
    }

    if (ctx.flags.has("run")) {
      ctx.io.step(ctx.io.c.dim("starting carbon dev…"));
      return this.startDev(plan.target);
    }

    ctx.io.info(`${ctx.io.c.dim("done.")} cd ${plan.target} && carbon dev`);
    return EXIT_OK;
  }

  // ── Scaffolding, with a recoverable path for "the directory isn't empty" ──

  /**
   * Runs the use case, and turns ScaffoldError into a printed message and a
   * null return rather than an exception — except TargetNotEmptyError in an
   * interactive session, which gets a chance to fix itself: warn, offer to
   * clear the directory, and retry once. A non-interactive caller (CI,
   * --yes, piped) always gets the old hard-refusal — deleting a directory's
   * contents is not something to do on a default/unattended path.
   */
  private async scaffold(
    ctx: CommandContext,
    request: CreateProjectRequest,
    interactive: boolean,
  ): Promise<CreateProjectResult | null> {
    try {
      return await createProjectUseCase().execute(request);
    } catch (e) {
      if (e instanceof TargetNotEmptyError && interactive) {
        return this.offerToClearAndRetry(ctx, e.target, request);
      }
      if (e instanceof ScaffoldError) {
        ctx.io.error(e.message);
        return null;
      }
      throw e;
    }
  }

  private async offerToClearAndRetry(
    ctx: CommandContext,
    target: string,
    request: CreateProjectRequest,
  ): Promise<CreateProjectResult | null> {
    let count = 0;
    try { count = readdirSync(target).length; } catch { /* report without a count */ }
    ctx.io.warn(
      `${ctx.io.c.bold(target)} already exists and is not empty` +
        `${count ? ` (${count} item${count === 1 ? "" : "s"})` : ""}.`,
    );

    const action = await ctx.io.select(
      "What now?",
      [
        { label: "Cancel", value: "cancel" as const, hint: "leave it untouched" },
        { label: "Clear the directory and continue", value: "clear" as const, hint: "deletes everything inside it" },
      ],
      { defaultIndex: 0 },
    );
    if (action !== "clear") return null;

    try {
      // Delete every ENTRY inside target, not target itself. Two reasons,
      // one of them not optional: with --here / a "." answer, target IS
      // the process's own cwd, and Windows holds a lock on a running
      // process's cwd — rmSync(target) then failed with "EBUSY: resource
      // busy or locked", confirmed directly. The other: even for a named,
      // non-cwd target, recreating the directory instead of just emptying
      // it is needless — nothing about the directory's own identity
      // (permissions, whether it's a mount point or symlink) should
      // change just because we're clearing what's inside it.
      for (const entry of readdirSync(target)) {
        rmSync(join(target, entry), { recursive: true, force: true });
      }
    } catch (e) {
      ctx.io.error(`could not clear ${target}: ${(e as Error).message}`);
      return null;
    }

    // Retry non-interactively: the directory should be empty now, so a
    // second TargetNotEmptyError means something outside our control is
    // still writing to it — hard-refuse rather than loop.
    return this.scaffold(ctx, request, false);
  }

  // ── Interactive menu ───────────────────────────────────────────────────────

  private async pickPreset(wizard: Wizard): Promise<string> {
    const RENDERERS: Array<{ id: Renderer; label: string; desc: string }> = [
      { id: "solid", label: "Solid", desc: "reactive signals, Solid-style JSX" },
      { id: "react", label: "React", desc: "React 18, familiar hooks API" },
    ];

    const renderer = await wizard.select(
      "Pick a renderer",
      RENDERERS.map((r) => ({ label: r.label, value: r.id, hint: r.desc })),
    );

    // "three" carries renderer: "solid" (it's Solid-only for now), so
    // filtering on renderer alone already includes it under Solid and
    // excludes it under React — no separate case needed.
    const stackOptions = MENU_PRESETS.filter((p) => p.renderer === renderer);

    const chosen = await wizard.select(
      "Pick a stack",
      stackOptions.map((p) => ({ label: p.name, value: p, hint: p.summary })),
    );

    return chosen.name;
  }

  private listPresets(ctx: CommandContext): void {
    ctx.io.raw("");
    ctx.io.raw(ctx.io.c.bold("Available presets:"));
    ctx.io.raw("");
    const width = Math.max(...MENU_PRESETS.map((p) => p.name.length));
    for (const p of MENU_PRESETS) {
      ctx.io.raw(
        `  ${ctx.io.c.cyan(p.name.padEnd(width))}  ${ctx.io.c.dim(p.summary)}`,
      );
    }
    ctx.io.raw("");
  }

  private async startDev(target: string): Promise<ExitCode> {
    const entry = join(CARBON_ROOT, "products", "carbon-cli", "main.ts");
    const { code } = await run("bun", [entry, "dev", target], { stdio: "inherit" });
    return code as ExitCode;
  }
}

function basenameOf(dir: string): string | undefined {
  return dir.split(/[\\/]/).filter(Boolean).pop();
}

export default InitCommand;
