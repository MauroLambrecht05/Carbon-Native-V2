// `carbon init [name]` — scaffold a new project.
//
// Argv in, output out. Everything that decides what a project consists of —
// presets, templates, path arithmetic, the filesystem — is @carbon/scaffolding,
// because none of it is specific to a terminal. This file is the driving
// adapter: it reads flags, calls one use case, and prints the result.
//
// It used to be 532 lines with fourteen embedded templates in it.

import {
  Command,
  EXIT_OK,
  EXIT_USAGE,
  type CommandMeta,
  type CommandContext,
  type ExitCode,
} from "@carbon/cli";
import {
  createProjectUseCase,
  PRESETS,
  PRESET_NAMES,
  DEFAULT_PRESET,
  ScaffoldError,
} from "@carbon/scaffolding";
import { CARBON_ROOT } from "@carbon/workspace";
import { run } from "@carbon/process";
import { join } from "node:path";

export class InitCommand extends Command {
  readonly meta: CommandMeta = {
    name: "init",
    aliases: ["new"],
    summary: "Scaffold a new project",
    usage: "init <name> [options]",
    flags: [
      {
        name: "preset",
        placeholder: "<preset>",
        description: PRESET_NAMES.join(" | "),
        default: DEFAULT_PRESET,
      },
      { name: "backend", placeholder: "<backend>", description: "Runtime backend", default: "mini" },
      { name: "here", boolean: true, description: "Scaffold into the current directory" },
      { name: "no-install", boolean: true, description: "Skip the bun install afterwards" },
      { name: "run", boolean: true, description: "Start carbon dev once scaffolded" },
      { name: "list-presets", boolean: true, description: "Show the available presets and exit" },
    ],
    examples: ["carbon init my-app", "carbon init my-app --preset tailwind"],
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    if (ctx.flags.has("list-presets")) {
      this.listPresets(ctx);
      return EXIT_OK;
    }

    // With --here and no name, the directory's own name is the project name.
    const name = ctx.first ?? (ctx.flags.has("here") ? basenameOf(ctx.cwd) : undefined);
    if (!name) {
      ctx.io.error("init requires a project name. Try: carbon init my-app");
      return EXIT_USAGE;
    }

    let result;
    try {
      result = await createProjectUseCase().execute({
        name,
        here: ctx.flags.has("here"),
        cwd: ctx.cwd,
        workspaceRoot: CARBON_ROOT,
        preset: ctx.flags.get("preset", DEFAULT_PRESET),
        backend: ctx.flags.get("backend", "mini"),
        install: !ctx.flags.has("no-install"),
      });
    } catch (e) {
      // Scaffolding's own refusals are user-facing messages, not bugs; anything
      // else is a real failure and should surface with its stack.
      if (e instanceof ScaffoldError) {
        ctx.io.error(e.message);
        return EXIT_USAGE;
      }
      throw e;
    }

    const { plan, scaffoldMs, installExitCode } = result;
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

  private listPresets(ctx: CommandContext): void {
    ctx.io.info("Usage: carbon init <name> [--preset <preset>] [--here] [--no-install] [--run]");
    ctx.io.raw("");
    ctx.io.raw("Available presets:");
    const width = Math.max(...PRESETS.map((p) => p.name.length));
    for (const preset of PRESETS) {
      ctx.io.raw(`  ${preset.name.padEnd(width)}  ${ctx.io.c.dim(preset.summary)}`);
    }
    ctx.io.raw("");
  }

  /**
   * Handing off to `carbon dev` in the new project.
   *
   * Spawned rather than called in-process so the dev server owns the terminal
   * and Ctrl-C reaches it, not us. This stays in the product: chaining one
   * command into another is a CLI concern, not something scaffolding decides.
   */
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
