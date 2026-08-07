// carbon-plugin.toml — what a plugin says about itself.
//
// Parsed with the same shallow line reader as the [plugins] section, and for a
// related reason: this file is read to answer two questions (what is it called,
// what language is it) long before anything is willing to depend on a TOML
// parser being present. Unknown keys are ignored rather than rejected, so a
// manifest carrying fields this version does not model still installs.

import {
  DEFAULT_PLUGIN_LANGUAGE,
  DEFAULT_PLUGIN_NAME,
} from "@carbon/contracts/plugin";
import { RUST, languageNamed, type PluginLanguage } from "../value-objects/PluginLanguage.ts";
import { PluginName } from "../value-objects/PluginName.ts";

export class PluginManifest {
  constructor(
    readonly name: PluginName,
    readonly language: PluginLanguage,
  ) {}

  /**
   * Reads name and language out of a carbon-plugin.toml.
   *
   * Both have defaults, because a manifest that omits them is not an error —
   * "plugin" and Rust are what the V1 CLI assumed, and manifests written
   * against it are in the wild.
   */
  static parse(toml: string): PluginManifest {
    let name: string = DEFAULT_PLUGIN_NAME;
    let language: string = DEFAULT_PLUGIN_LANGUAGE;

    for (const rawLine of toml.split("\n")) {
      // Strip trailing comments before splitting, so `name = "x"  # note`
      // does not put the comment in the value.
      const line = rawLine.split("#")[0].trim();
      const eq = line.indexOf("=");
      if (eq < 0) continue;

      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
      if (key === "name") name = value;
      else if (key === "language") language = value;
    }

    return new PluginManifest(PluginName.from(name), languageNamed(language) ?? RUST);
  }
}
