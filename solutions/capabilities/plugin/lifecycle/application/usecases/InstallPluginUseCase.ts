// Installing a built plugin into a host app.
//
// Three steps that have to agree: find the artifact the build produced, copy it
// into the app's plugins/ directory, and declare it in the app's carbon.toml.
// The third is what makes the runtime load it; the first two without it install
// a file nothing reads.

import { basename, join } from "node:path";
import { PluginManifest } from "../../domain/entities/PluginManifest.ts";
import {
  ArtifactNotFoundError,
  NoHostAppError,
  NotAPluginDirectoryError,
} from "../../domain/errors/PluginError.ts";
import { upsertPluginEntry } from "../../domain/services/PluginsSection.ts";
import { LANGUAGES, type PluginLanguage } from "../../domain/value-objects/PluginLanguage.ts";
import { PluginName } from "../../domain/value-objects/PluginName.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";
import { forwardSlashes } from "./CreatePluginUseCase.ts";

export interface InstallPluginRequest {
  /** Directory holding the built plugin. */
  readonly directory: string;
  /** Where to start looking for the host app. Usually the cwd. */
  readonly from: string;
}

export interface InstallPluginResult {
  readonly name: PluginName;
  readonly host: string;
  /** Absolute path the library was copied to. */
  readonly installedAt: string;
  /** The path as written into carbon.toml, relative to the app. */
  readonly declaredPath: string;
}

export interface LocatedArtifact {
  readonly path: string;
  readonly name: PluginName;
  readonly language: PluginLanguage;
}

export class InstallPluginUseCase {
  constructor(private readonly workspace: PluginWorkspace) {}

  /**
   * Finds the library a build produced.
   *
   * The manifest is preferred because it is authoritative about the name — the
   * directory may have been renamed. Without one, the name falls back to the
   * directory and the language to whichever marker file is present.
   */
  locateArtifact(directory: string): LocatedArtifact {
    const manifestPath = join(directory, "carbon-plugin.toml");

    let name: PluginName;
    let language: PluginLanguage;

    if (this.workspace.exists(manifestPath)) {
      const manifest = PluginManifest.parse(this.workspace.readFile(manifestPath));
      name = manifest.name;
      language = manifest.language;
    } else {
      name = PluginName.from(basename(directory) || "plugin");
      const detected = LANGUAGES.find((l) => this.workspace.exists(join(directory, l.marker)));
      if (!detected) throw new NotAPluginDirectoryError(directory);
      language = detected;
    }

    const filename = name.libraryFilename();
    const candidates = language.artifactDirs.map((parts) => join(directory, ...parts, filename));

    for (const candidate of candidates) {
      if (this.workspace.exists(candidate)) return { path: candidate, name, language };
    }

    throw new ArtifactNotFoundError(name.slug, candidates.map(forwardSlashes));
  }

  execute(request: InstallPluginRequest): InstallPluginResult {
    const artifact = this.locateArtifact(request.directory);

    const host = this.workspace.findHostApp(request.from);
    if (!host) throw new NoHostAppError(request.from);

    const pluginsDir = join(host, "plugins");
    this.workspace.createDirectory(pluginsDir);

    const filename = basename(artifact.path);
    const installedAt = join(pluginsDir, filename);
    this.workspace.copyFile(artifact.path, installedAt);

    // Relative and forward-slashed: the manifest is committed and read on
    // every platform, so an absolute Windows path in it breaks the project
    // for everyone else.
    const declaredPath = `./plugins/${filename}`;

    const tomlPath = join(host, "carbon.toml");
    const existing = this.workspace.exists(tomlPath) ? this.workspace.readFile(tomlPath) : "";
    this.workspace.writeFile(
      tomlPath,
      upsertPluginEntry(existing, { name: artifact.name.slug, path: declaredPath }),
    );

    return { name: artifact.name, host, installedAt, declaredPath };
  }
}
