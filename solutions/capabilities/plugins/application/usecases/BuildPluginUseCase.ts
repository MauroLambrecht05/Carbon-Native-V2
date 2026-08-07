// Building a native plugin: cargo or zig, chosen by what is in the directory.

import { join } from "node:path";
import type { ProcessRunner } from "@carbon/process";
import { NotAPluginDirectoryError } from "../../domain/errors/PluginError.ts";
import { LANGUAGES, type PluginLanguage } from "../../domain/value-objects/PluginLanguage.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";

export interface BuildPluginRequest {
  readonly directory: string;
  readonly release?: boolean;
}

export interface BuildPluginResult {
  readonly language: PluginLanguage;
  readonly release: boolean;
  readonly exitCode: number;
}

export class BuildPluginUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly processes: ProcessRunner,
  ) {}

  /**
   * Which language a directory holds, by marker file.
   *
   * Rust is checked first, matching the CLI's original order — a directory
   * with both is treated as a Rust project whose build.zig is incidental.
   */
  detectLanguage(directory: string): PluginLanguage | undefined {
    return LANGUAGES.find((l) => this.workspace.exists(join(directory, l.marker)));
  }

  async execute(request: BuildPluginRequest): Promise<BuildPluginResult> {
    const language = this.detectLanguage(request.directory);
    if (!language) throw new NotAPluginDirectoryError(request.directory);

    const release = request.release ?? false;
    const args = [...(release ? language.releaseArgs : language.debugArgs)];

    const { code } = await this.processes.run(language.buildCommand, args, {
      cwd: request.directory,
      stdio: "inherit",
    });

    return { language, release, exitCode: code };
  }
}
