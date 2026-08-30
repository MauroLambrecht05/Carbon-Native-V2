// Building a native plugin: cargo or zig, chosen by what is in the directory.

import { join } from "node:path";
import type { ProcessRunner } from "@carbon/process";
import { MemoryLogger, type Logger } from "@carbon/logging";
import { NotAPluginDirectoryError } from "../../domain/errors/PluginError.ts";
import { LANGUAGES, type PluginLanguage } from "../../domain/value-objects/PluginLanguage.ts";
import { ensureZig } from "../../infrastructure/ZigToolchain.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";

export interface BuildPluginRequest {
  readonly directory: string;
  readonly release?: boolean;
  /** Reports progress — a Zig toolchain download in particular can take a
   *  while on first use. Defaults to a discarded MemoryLogger so callers
   *  that don't care (tests, SyncLocalPluginsUseCase's hot-reload path)
   *  don't have to pass one. */
  readonly logger?: Logger;
}

export interface BuildPluginResult {
  readonly language: PluginLanguage;
  readonly release: boolean;
  readonly exitCode: number;
}

/** Resolves the actual command to spawn for a language — real, absolute-path
 *  toolchain resolution (`ensureZig`) in production; a test double can
 *  return `language.buildCommand` verbatim to keep asserting on the exact
 *  spawned string without hitting the network or the filesystem. */
export type ResolveBuildCommand = (language: PluginLanguage, logger: Logger) => Promise<string>;

const defaultResolveCommand: ResolveBuildCommand = (language, logger) =>
  language.id === "zig" ? ensureZig(logger) : Promise.resolve(language.buildCommand);

export class BuildPluginUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly processes: ProcessRunner,
    private readonly resolveCommand: ResolveBuildCommand = defaultResolveCommand,
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
    const logger = request.logger ?? new MemoryLogger();

    // Resolved fresh (not cached on `language`): the whole point of
    // ZigToolchain.ts's ensureZig is that `language.buildCommand`'s bare
    // "zig" is not trustworthy — see its header comment for why a real
    // absolute path is used instead of ever spawning that string directly.
    const command = await this.resolveCommand(language, logger);

    const { code } = await this.processes.run(command, args, {
      cwd: request.directory,
      stdio: "inherit",
    });

    return { language, release, exitCode: code };
  }
}
