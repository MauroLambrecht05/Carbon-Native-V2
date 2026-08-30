// The filesystem, as the plugin use cases need it.
//
// Wider than scaffolding's equivalent because these use cases read as well as
// write, and one of them has to walk up the tree looking for a host app. Still
// narrow enough to enumerate: this is everything carbon/ can do to a disk.

import type { PluginLanguage } from "../../domain/value-objects/PluginLanguage.ts";
import type { PluginName } from "../../domain/value-objects/PluginName.ts";

export interface PluginWorkspace {
  exists(path: string): boolean;
  isEmptyDirectory(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, contents: string): void;
  createDirectory(path: string): void;
  copyFile(from: string, to: string): void;

  /**
   * Immediate subdirectory names of `path`, or `[]` if it does not exist.
   */
  listDirectories(path: string): string[];

  /**
   * Immediate file names (not subdirectories) of `path`, or `[]` if it does
   * not exist. What `SyncPluginsUseCase` lists to report what `carbon/
   * build.zig` actually staged into `carbon/native/<os>/<arch>/`.
   */
  listFiles(path: string): string[];

  /**
   * Nearest ancestor of `from` (inclusive) containing a carbon.toml.
   *
   * Walking up is what makes `carbon plugin install` work from anywhere inside
   * a project rather than only at its root.
   */
  findHostApp(from: string): string | null;
}

export interface PluginTemplateRequest {
  readonly name: PluginName;
  readonly language: PluginLanguage;
  /**
   * Relative path from the new plugin back to the SDK, written into the
   * generated Cargo.toml / build.zig.zon so it can depend on it.
   */
  readonly sdkPath: string;
}

export interface PluginTemplateFile {
  /** Relative to the plugin root. */
  readonly path: string;
  readonly contents: string;
}

/** Where a plugin's starting files come from. */
export interface PluginTemplateSource {
  filesFor(request: PluginTemplateRequest): PluginTemplateFile[];

  /**
   * The fixed files an app's carbon/ directory needs before it can hold any
   * plugin: build.zig, build.zig.zon, manifest.toml. No per-request
   * placeholders — identical for every app, scaffolded lazily by
   * CreatePluginUseCase the first time a host app gets its first plugin.
   */
  appCarbonDirFiles(): PluginTemplateFile[];
}
