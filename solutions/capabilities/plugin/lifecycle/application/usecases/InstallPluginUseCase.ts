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

    // carbon/installed/<slug>/{<filename>, <filename>.sig, carbon-plugin.
    // toml} — one subdirectory per plugin, inside the app's `carbon/`
    // development area (see SyncLocalPluginsUseCase's header comment for
    // the full picture: carbon/installed/ holds fetched-or-built
    // artifacts, distinct from carbon/own/, where a developer's OWN plugin
    // SOURCE lives). This is the SAME shape `scanPluginDirs`
    // (import-manifest.js) already expects for a manifest — a bare
    // carbon-plugin.toml inside a per-plugin directory — and what
    // InspectPluginsUseCase.describe() already looks for beside the
    // installed artifact.
    const pluginDir = join(host, "carbon", "installed", artifact.name.slug);
    this.workspace.createDirectory(pluginDir);

    const filename = basename(artifact.path);
    const installedAt = join(pluginDir, filename);
    this.workspace.copyFile(artifact.path, installedAt);

    // A signed artifact (see PluginSigner.ts — carbon-sdk plugins are
    // signed as part of `carbon plugin add`) has a detached `<name>.sig`
    // beside it; carry it along, or the loader's signature check has
    // nothing to verify against once installed and refuses the plugin.
    // Optional: a locally-built, unsigned third-party plugin (`carbon
    // plugin install`) has no .sig at all, which is fine outside `carbon
    // dev` — that's the documented, unconditional-refusal case, not a bug.
    const sigSrc = `${artifact.path}.sig`;
    if (this.workspace.exists(sigSrc)) {
      this.workspace.copyFile(sigSrc, `${installedAt}.sig`);
    }

    // Copy the manifest into carbon/installed/<slug>/, bare as
    // "carbon-plugin.toml" — matching scanPluginDirs' expected filename.
    // `request.directory` is where this plugin was BUILT: for a prebuilt
    // artifact (`carbon plugin install` / `add`) that's the SDK/source
    // checkout; for a vendored plugin (SyncLocalPluginsUseCase) it's
    // carbon/own/<slug>/ — a genuinely different directory from
    // carbon/installed/<slug>/ now, so this copy is real in both cases
    // (the `!==` guard below only protects the degenerate edge case of
    // `directory`/`from` being passed in already equal to the install
    // target, which normal callers never do).
    const manifestSrc = join(request.directory, "carbon-plugin.toml");
    const manifestDest = join(pluginDir, "carbon-plugin.toml");
    if (manifestSrc !== manifestDest && this.workspace.exists(manifestSrc)) {
      this.workspace.copyFile(manifestSrc, manifestDest);
    }

    // Relative and forward-slashed: the manifest is committed and read on
    // every platform, so an absolute Windows path in it breaks the project
    // for everyone else.
    const declaredPath = `./carbon/installed/${artifact.name.slug}/${filename}`;

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
