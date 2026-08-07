// `carbon bundle` — create OS-specific installers.
//
// ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
// It does not build an installer. @carbon/packaging has a generator per target
// and none of them is called from anywhere; this command validates the request,
// reports what it would build, and exits 0. That was true of the V1 version too
// and is preserved rather than quietly half-implemented — a `carbon bundle`
// that emits a broken .msi is worse than one that admits it is not wired up.
//
// The `--dry-run` wording below is the honest description of every run, which
// is why the success line says "would build".
//
// What did change: the target list now comes from contracts/distribution
// instead of being written out five times in this file. One of those five
// copies disagreed with the others — the DMG branch compared a normalised
// platform name against a raw one, so `--target dmg` was unreachable on macOS.

import {
  Command,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  type CommandContext,
  type CommandMeta,
  type ExitCode,
} from "@carbon/cli";
import {
  INSTALLER_TARGETS,
  INSTALLER_TARGET_IDS,
  installerTarget,
  isBuildableOn,
  targetsForPlatform,
} from "@carbon/contracts/distribution";
import { loadConfig } from "@carbon/workspace";
import { existsSync } from "node:fs";

export class BundleCommand extends Command {
  readonly meta: CommandMeta = {
    name: "bundle",
    summary: "Create OS-specific installers",
    usage: "bundle --target <targets> [options]",
    flags: [
      {
        name: "target",
        placeholder: "<targets>",
        description: `${INSTALLER_TARGET_IDS.join(" | ")} | all — comma-separated`,
      },
      { name: "input", placeholder: "<dir>", description: "Input directory", default: "dist" },
      {
        name: "out",
        placeholder: "<dir>",
        description: "Output directory",
        default: "dist/installers",
      },
    ],
    examples: [
      "carbon bundle --target nsis",
      "carbon bundle --target all",
      "carbon bundle --target appimage --out ./installers/",
    ],
  };

  validate(ctx: CommandContext): string | null {
    return ctx.flags.get("target") ? null : "--target is required";
  }

  async execute(ctx: CommandContext): Promise<ExitCode> {
    const requested = ctx.flags.get("target")!;
    const inputDir = ctx.flags.get("input", "dist")!;
    const outDir = ctx.flags.get("out", "dist/installers")!;

    try {
      const config = await loadConfig();
      if (!config.app) {
        ctx.io.error("Missing [app] section in carbon.toml");
        return EXIT_FAILURE;
      }

      if (!existsSync(inputDir)) {
        ctx.io.error(`Input directory not found: ${inputDir}`);
        return EXIT_FAILURE;
      }

      // `all` means everything applicable on this machine; anything else is a
      // comma-separated list of ids.
      const names =
        requested === "all"
          ? targetsForPlatform().map((t) => t.id)
          : requested.split(",").map((t) => t.trim()).filter(Boolean);

      if (names.length === 0) {
        ctx.io.warn(`no installer targets apply on ${process.platform}`);
        return EXIT_OK;
      }

      for (const name of names) {
        const target = installerTarget(name);
        if (!target) {
          ctx.io.warn(`Unknown target: ${name} (skipping)`);
          continue;
        }

        if (!isBuildableOn(target)) {
          // Cross-building is not supported: each installer needs its own
          // platform's toolchain.
          ctx.io.warn(`${target.id} requires ${target.platform}, skipping`);
          continue;
        }

        ctx.io.step(`Building ${target.id} installer...`);
        ctx.io.success(`would build ${target.id} into ${outDir}/${target.id}/`);
      }

      return EXIT_OK;
    } catch (e) {
      // `e` is `unknown` under strict mode, and a throw is not required to be
      // an Error — `throw "boom"` is legal. instanceof rather than a cast so a
      // non-Error renders instead of reading `.message` off a string.
      ctx.io.error(`Bundle failed: ${e instanceof Error ? e.message : String(e)}`);
      return EXIT_FAILURE;
    }
  }
}

/**
 * The target table, for `carbon help bundle`.
 *
 * Exported so the help renderer can show what `--target` accepts without this
 * file keeping its own copy of the list.
 */
export function describeTargets(): string {
  const width = Math.max(...INSTALLER_TARGETS.map((t) => t.id.length), "all".length);
  const rows = INSTALLER_TARGETS.map((t) => `  ${t.id.padEnd(width)}  ${t.summary}`);
  rows.push(`  ${"all".padEnd(width)}  Every applicable target for the current platform`);
  return rows.join("\n");
}

export default BundleCommand;
export { EXIT_USAGE };
