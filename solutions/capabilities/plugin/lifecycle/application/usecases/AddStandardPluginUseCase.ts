// Build + sign + install one standard (carbon-sdk) plugin into a host app.
//
// The one place this logic lives — used by BOTH `carbon plugin add <name>`
// (a human asking for it explicitly, once) and SyncPluginsUseCase's auto-heal
// step (an app's carbon/manifest.toml already declares a vendor plugin, but
// its artifact is missing — fresh clone, CI, a teammate's machine — and no
// human is expected to run a command for that). Same build, same sign, same
// install; only who triggers it differs.

import { join } from "node:path";
import type { Logger } from "@carbon/logging";
import { MemoryLogger } from "@carbon/logging";
import { UnknownStandardPluginError } from "../../domain/errors/PluginError.ts";
import { signStandardPluginArtifact } from "../../infrastructure/PluginSigner.ts";
import type { PluginName } from "../../domain/value-objects/PluginName.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";
import type { BuildPluginUseCase } from "./BuildPluginUseCase.ts";
import type { InstallPluginUseCase } from "./InstallPluginUseCase.ts";

export interface AddStandardPluginRequest {
  readonly name: string;
  /** The app to install into. */
  readonly targetApp: string;
  readonly logger?: Logger;
}

export interface AddStandardPluginResult {
  readonly name: PluginName;
  readonly host: string;
  readonly installedAt: string;
}

export class AddStandardPluginUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly build: BuildPluginUseCase,
    private readonly install: InstallPluginUseCase,
    private readonly standardPluginsRoot: string,
    private readonly sign: (artifactPath: string, logger: Logger) => Promise<void> = signStandardPluginArtifact,
  ) {}

  async execute(request: AddStandardPluginRequest): Promise<AddStandardPluginResult> {
    const directory = join(this.standardPluginsRoot, request.name);
    if (!this.workspace.exists(directory)) {
      throw new UnknownStandardPluginError(
        request.name,
        this.workspace.listDirectories(this.standardPluginsRoot),
      );
    }

    const logger = request.logger ?? new MemoryLogger();

    // Always release, unlike `plugin build`'s opt-in --release: a standard
    // plugin someone is fetching to use, not actively developing, should
    // behave the way installing any other dependency does.
    const built = await this.build.execute({ directory, release: true, logger });
    if (built.exitCode !== 0) {
      throw new Error(`building ${request.name} failed — exit code ${built.exitCode}`);
    }

    // Standard (carbon-sdk) plugins are official Carbon plugins, not a
    // developer's own third-party build — they get signed with Carbon's real
    // key here, unconditionally. See PluginSigner.ts for the full reasoning.
    const artifact = this.install.locateArtifact(directory);
    logger.step(`signing ${artifact.name.slug}…`);
    await this.sign(artifact.path, logger);

    return this.install.execute({ directory, from: request.targetApp });
  }
}
