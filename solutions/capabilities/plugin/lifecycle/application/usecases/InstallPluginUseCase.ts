// Installing a built plugin into a host app as a VENDOR plugin.
//
// Two things land in two different places, deliberately not one:
//   carbon/bin/<os>/<arch>/<slug>.<ext> (+ .sig)   — the binary the
//     runtime actually loads. THE only copy — carbon/build.zig never
//     touches a vendor plugin's artifact at all, so there is nothing to
//     duplicate it here for.
//   carbon/plugins/vendor/<slug>/carbon-plugin.toml   — the manifest, which
//     the bundler and `describe` read to know the plugin's exports/
//     capabilities. Small and durable; not build output.
// Both are keyed by carbon/manifest.toml's declaration (source = "vendor"),
// which is what actually makes the runtime look for either.
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
import { upsertManifestEntry } from "../../infrastructure/AppManifestCodec.ts";
import { LANGUAGES, type PluginLanguage } from "../../domain/value-objects/PluginLanguage.ts";
import { hostArchName, hostExt, hostOsName } from "../../domain/value-objects/NativeTarget.ts";
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

    // The binary + signature go straight into carbon/bin/<os>/<arch>/,
    // staged name (<slug>.<ext>, no crate-form/lib-prefix) — the same
    // convention carbon/build.zig uses for a local plugin, so the loader's
    // lookup is identical either way.
    const binDir = join(host, "carbon", "bin", hostOsName(), hostArchName());
    const ext = hostExt();
    const installedAt = join(binDir, `${artifact.name.slug}.${ext}`);
    this.workspace.copyFile(artifact.path, installedAt);

    // A signed artifact (see PluginSigner.ts — carbon-sdk plugins are
    // signed as part of `carbon plugin add`) has a detached `<name>.sig`
    // beside it; carry it along, or the loader's signature check has
    // nothing to verify against once staged and refuses the plugin.
    const sigSrc = `${artifact.path}.sig`;
    if (this.workspace.exists(sigSrc)) {
      this.workspace.copyFile(sigSrc, `${installedAt}.sig`);
    }

    // The manifest is the one thing that lives in plugins/vendor/<slug>/ —
    // not build output, just a small durable record of exports/capabilities
    // (see this file's header comment for why it's split from the binary).
    const pluginDir = join(host, "carbon", "plugins", "vendor", artifact.name.slug);
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
