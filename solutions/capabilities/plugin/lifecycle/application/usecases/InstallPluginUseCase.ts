// Installing a built plugin into a host app as a VENDOR plugin.
//
// Three steps that have to agree: find the artifact the build produced, copy
// it into carbon/plugins/vendor/<slug>/, and declare it in carbon/manifest.toml
// (source = "vendor"). The third is what makes carbon/build.zig stage it and
// the runtime load it; the first two without it install a file nothing reads.
//
// This never touches carbon.toml — that file only grants capabilities to a
// name manifest.toml already declares (see CapabilityGrants.ts), it never
// says a plugin exists.

import { basename, join } from "node:path";
import { PluginManifest } from "../../domain/entities/PluginManifest.ts";
import {
  ArtifactNotFoundError,
  NoHostAppError,
  NotAPluginDirectoryError,
} from "../../domain/errors/PluginError.ts";
import { upsertManifestEntry } from "../../domain/services/AppManifestSection.ts";
import { LANGUAGES, type PluginLanguage } from "../../domain/value-objects/PluginLanguage.ts";
import { PluginName } from "../../domain/value-objects/PluginName.ts";
import type { PluginTemplateSource, PluginWorkspace } from "../ports/PluginWorkspace.ts";
import { forwardSlashes } from "./CreatePluginUseCase.ts";
import { ensureAppCarbonDir } from "./EnsureAppCarbonDir.ts";

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
}

export interface LocatedArtifact {
  readonly path: string;
  readonly name: PluginName;
  readonly language: PluginLanguage;
}

export class InstallPluginUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly templates: PluginTemplateSource,
  ) {}

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

    // carbon/plugins/vendor/<slug>/{<filename>, <filename>.sig,
    // carbon-plugin.toml} — this is source-of-record for the plugin's
    // artifact-origin, not for whether the runtime loads it: carbon/build.zig
    // stages the binary into carbon/native/<os>/<arch>/ from here, keyed by
    // carbon/manifest.toml's declaration below.
    const pluginDir = join(host, "carbon", "plugins", "vendor", artifact.name.slug);
    this.workspace.createDirectory(pluginDir);

    const filename = basename(artifact.path);
    const installedAt = join(pluginDir, filename);
    this.workspace.copyFile(artifact.path, installedAt);

    // A signed artifact (see PluginSigner.ts — carbon-sdk plugins are
    // signed as part of `carbon plugin add`) has a detached `<name>.sig`
    // beside it; carry it along, or the loader's signature check has
    // nothing to verify against once staged and refuses the plugin.
    const sigSrc = `${artifact.path}.sig`;
    if (this.workspace.exists(sigSrc)) {
      this.workspace.copyFile(sigSrc, `${installedAt}.sig`);
    }

    // Copy the manifest into plugins/vendor/<slug>/, bare as
    // "carbon-plugin.toml" — matching scanPluginDirs' expected filename.
    const manifestSrc = join(request.directory, "carbon-plugin.toml");
    const manifestDest = join(pluginDir, "carbon-plugin.toml");
    if (manifestSrc !== manifestDest && this.workspace.exists(manifestSrc)) {
      this.workspace.copyFile(manifestSrc, manifestDest);
    }

    ensureAppCarbonDir(this.workspace, this.templates, host);

    const manifestPath = join(host, "carbon", "manifest.toml");
    const existing = this.workspace.exists(manifestPath) ? this.workspace.readFile(manifestPath) : "";
    this.workspace.writeFile(
      manifestPath,
      upsertManifestEntry(existing, artifact.name.slug, { source: "vendor", enabled: true }),
    );

    return { name: artifact.name, host, installedAt };
  }
}
