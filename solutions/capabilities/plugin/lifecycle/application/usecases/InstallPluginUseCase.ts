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
  /**
   * Write the bare `name = "path"` line into carbon.toml. Default true.
   *
   * `false` for a re-install over an entry an author has since upgraded to
   * the `[plugins.<name>]` table form (to grant capabilities, say) —
   * upsertPluginEntry only understands the bare form, so it would either
   * clobber the grant back to a plain path or, worse, add a SECOND
   * declaration of the same key that TOML treats as a duplicate. Copying the
   * refreshed artifact in is still correct either way; only the declare step
   * is conditional.
   */
  readonly declare?: boolean;
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

    // Copy the manifest alongside the artifact, flat as `<slug>.carbon-
    // plugin.toml` — NOT nested in a `plugins/<name>/` subdirectory the way
    // a local-source plugin's own manifest lives. Without this, a plugin
    // installed as a prebuilt artifact (carbon plugin install / add) has no
    // way to tell the bundler's `carbon:*` import resolver what it exports:
    // discoverLocalManifests only used to look for plugins/<name>/carbon-
    // plugin.toml, so `import { loadFont } from "carbon:fonts"` fell through
    // to "unknown virtual module" for every app that installed a plugin this
    // way instead of vendoring its Zig source. See import-manifest.js's
    // scanFlatManifests for the matching read side.
    const manifestSrc = join(request.directory, "carbon-plugin.toml");
    if (this.workspace.exists(manifestSrc)) {
      const manifestDest = join(pluginsDir, `${artifact.name.slug}.carbon-plugin.toml`);
      this.workspace.copyFile(manifestSrc, manifestDest);
    }

    // Relative and forward-slashed: the manifest is committed and read on
    // every platform, so an absolute Windows path in it breaks the project
    // for everyone else.
    const declaredPath = `./plugins/${filename}`;

    if (request.declare ?? true) {
      const tomlPath = join(host, "carbon.toml");
      const existing = this.workspace.exists(tomlPath) ? this.workspace.readFile(tomlPath) : "";
      this.workspace.writeFile(
        tomlPath,
        upsertPluginEntry(existing, { name: artifact.name.slug, path: declaredPath }),
      );
    }

    return { name: artifact.name, host, installedAt, declaredPath };
  }
}
