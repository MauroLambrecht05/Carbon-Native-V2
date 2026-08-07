// `carbon doctor` — is this machine set up to build carbon apps?
//
// Two changes from the ported version, both of which were bugs:
//
//   1. It could not fail. `allOk` was declared `const allOk = true` and the
//      one line that would have cleared it was commented out, so doctor
//      reported missing required tools in red and then exited 0. Anything
//      using it as a CI gate passed unconditionally. It now exits non-zero
//      when a required tool is missing.
//
//   2. It checked presence, never version. The versions this workspace is
//      built against live in .config/dependencies.json — the agreement in
//      contracts/toolchain — and doctor is the thing that tells a developer
//      their machine disagrees. A too-old Zig fails much later, in a linker
//      error nobody reads as "wrong Zig".
//
// Version mismatches are warnings, not failures: the declared version is what
// CI provisions, and blocking local work over a patch difference would be
// wrong. Missing required tools are failures.

import {
  Command,
  EXIT_FAILURE,
  EXIT_OK,
  type CommandContext,
  type CommandMeta,
  type ExitCode,
} from "@carbon/cli";
import { extractVersion, satisfies, type ToolchainVersions } from "@carbon/contracts/toolchain";
import { CARBON_ROOT } from "@carbon/workspace";
import { spawnSync } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Platform = "windows" | "macos" | "linux";

interface ToolInfo {
  name: string;
  command: string;
  args: string[];
  required: boolean;
  platformRequired: "all" | Platform | "unix";
  /** Key in dependencies.json to compare against, when there is one. */
  declaredAs?: string;
}

const tools: ToolInfo[] = [
  { name: "zig", command: "zig", args: ["version"], required: true, platformRequired: "all", declaredAs: "zig" },
  { name: "cargo-zigbuild", command: "cargo", args: ["zigbuild", "--version"], required: true, platformRequired: "all" },
  { name: "rustc", command: "rustc", args: ["--version"], required: true, platformRequired: "all", declaredAs: "rust" },
  { name: "go", command: "go", args: ["version"], required: false, platformRequired: "all", declaredAs: "go" },
  { name: "gpg", command: "gpg", args: ["--version"], required: true, platformRequired: "all" },
  { name: "wix", command: "wix", args: ["--version"], required: true, platformRequired: "windows" },
  { name: "makensis", command: "makensis", args: ["/VERSION"], required: true, platformRequired: "windows" },
  { name: "signtool", command: "signtool", args: ["/?"], required: true, platformRequired: "windows" },
  { name: "codesign", command: "codesign", args: ["-v"], required: true, platformRequired: "macos" },
  { name: "notarytool", command: "xcrun", args: ["notarytool", "--version"], required: true, platformRequired: "macos" },
  { name: "appimagetool", command: "appimagetool", args: ["--version"], required: false, platformRequired: "linux" },
  { name: "dpkg-deb", command: "dpkg-deb", args: ["--version"], required: false, platformRequired: "linux" },
];

function getPlatform(): Platform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

/** The declared versions, or null when the file is missing or unreadable. */
function declaredVersions(): ToolchainVersions | null {
  const path = join(CARBON_ROOT, ".config", "dependencies.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ToolchainVersions;
  } catch {
    // A malformed dependencies.json should not stop doctor from reporting
    // what it can — that is the run where you most want the rest of it.
    return null;
  }
}

interface CheckResult {
  found: boolean;
  /** First line of the tool's own version output. */
  banner: string;
  platformMismatch: boolean;
}

function checkTool(tool: ToolInfo): CheckResult {
  const currentPlatform = getPlatform();
  const platformMatch =
    tool.platformRequired === "all" ||
    tool.platformRequired === currentPlatform ||
    (tool.platformRequired === "unix" && currentPlatform !== "windows");

  if (!platformMatch) return { found: false, banner: "", platformMismatch: true };

  try {
    const result = spawnSync([tool.command, ...tool.args], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.success || result.stdout) {
      const output = result.stdout?.toString().split("\n")[0] ?? "";
      return { found: true, banner: output.substring(0, 50), platformMismatch: false };
    }
  } catch {
    // Not on PATH.
  }

  return { found: false, banner: "", platformMismatch: false };
}

export class DoctorCommand extends Command {
  readonly meta: CommandMeta = {
    name: "doctor",
    summary: "Check toolchain dependencies",
    usage: "doctor",
    examples: ["carbon doctor"],
  };

  async execute(ctx: CommandContext): Promise<ExitCode> {
    ctx.io.step("Checking dependencies...");

    const declared = declaredVersions();
    const missing: string[] = [];
    const mismatched: string[] = [];

    ctx.io.raw("");
    ctx.io.raw(ctx.io.c.bold("Toolchain Status:"));
    ctx.io.raw("");

    for (const tool of tools) {
      const result = checkTool(tool);
      const label = tool.name.padEnd(20);

      if (result.platformMismatch) {
        const only =
          tool.platformRequired === "all" ? "all" : `${tool.platformRequired} only`;
        ctx.io.raw(`  ${ctx.io.c.dim("✓")} ${label} ${ctx.io.c.dim(`(${only})`)}`);
        continue;
      }

      if (!result.found) {
        const mark = tool.required ? ctx.io.c.red("✗") : ctx.io.c.yellow("?");
        ctx.io.raw(`  ${mark} ${label} ${ctx.io.c.red("not found")}`);
        if (tool.required) missing.push(tool.name);
        continue;
      }

      const want = tool.declaredAs ? declared?.toolchains[tool.declaredAs] : undefined;
      const have = extractVersion(result.banner);

      if (want && have && !satisfies(want, have)) {
        ctx.io.raw(
          `  ${ctx.io.c.yellow("!")} ${label} ${ctx.io.c.dim(result.banner)} ` +
            `${ctx.io.c.yellow(`(expected ${want})`)}`,
        );
        mismatched.push(`${tool.name} ${have}, expected ${want}`);
        continue;
      }

      ctx.io.raw(`  ${ctx.io.c.green("✓")} ${label} ${ctx.io.c.dim(result.banner)}`);
    }

    ctx.io.raw("");

    for (const line of mismatched) {
      ctx.io.warn(`version mismatch: ${line}`);
    }

    if (missing.length > 0) {
      ctx.io.error(`missing required tools: ${missing.join(", ")}`);
      ctx.io.info(
        "The container in .tools/environments/docker has all of them installed and pinned.",
      );
      return EXIT_FAILURE;
    }

    ctx.io.success("all required tools present");
    return EXIT_OK;
  }
}

export default DoctorCommand;
