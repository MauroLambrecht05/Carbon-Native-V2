// `carbon bundle` — create OS-specific installers.
//
// ── WHAT THIS PRODUCES ──────────────────────────────────────────────────────
// The installer DEFINITION, not the installer: an NSIS `.nsi`, a WiX `.wxs`, a
// Debian `control` file. Turning one into a `.exe`/`.msi`/`.deb` needs
// makensis, the WiX toolset or dpkg-deb on the machine — `carbon doctor` is
// what checks for those.
//
// The command reported "would build" until @carbon/packaging grew a use case:
// the five generators existed and nothing called them. It writes files now, and
// says precisely which.
//
// The target list comes from contracts/distribution rather than being written
// out five times in this file. One of those five copies disagreed with the
// others — the DMG branch compared a normalised platform name against a raw
// one, so `--target dmg` was unreachable on macOS.

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
import { generatePackageUseCase } from "@carbon/packaging";
import { loadConfig, resolveBackendBinary } from "@carbon/workspace";
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

      // The installer wraps the built runtime. Without it there is nothing to
      // package, and a definition pointing at a missing binary is worse than
      // an error — it fails later, in the packaging tool, further from the
      // cause.
      const binary = resolveBackendBinary(config.runtime.backend);
      if (!binary) {
        ctx.io.error(
          `no runtime binary for the ${config.runtime.backend} backend — run \`carbon build\` first`,
        );
        return EXIT_FAILURE;
      }

      const generate = generatePackageUseCase();
      let written = 0;

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

        ctx.io.step(`Generating ${target.id} installer definition...`);
        const { path, bytes } = await generate.execute({
          target: target.id,
          config,
          binaryPath: binary,
          outputDir: outDir,
        });
        ctx.io.success(`${target.id}: ${path} (${bytes} bytes)`);
        written++;
      }

      if (written === 0) {
        ctx.io.warn("nothing was generated");
        return EXIT_FAILURE;
      }
      ctx.io.info(
        `${written} definition(s) written. They are packaging-tool INPUT — run ` +
          `makensis / wix / dpkg-deb to produce an installer.`,
      );
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
