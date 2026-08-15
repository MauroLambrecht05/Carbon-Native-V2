// Does this plugin's manifest describe something the runtime can load?
//
// Everything here is checkable without building the plugin, and every one of
// them is otherwise discovered at launch, as a line on stderr, after the app
// has already failed to do what the user asked:
//
//   * an extension point id that does not exist in the registry
//   * a point whose capability the plugin does not declare as required
//   * an experimental point, which is allowed but should be a deliberate choice
//   * a manifest whose language is not the one this toolchain builds
//
// The one thing it cannot check is whether the plugin actually EXPORTS the
// symbols it declares — that needs the built library, and the loader reports
// it at load time.

import { join } from "node:path";

import {
  EXTENSION_POINT_IDS,
  extensionPoint,
  type ExtensionPointSpec,
} from "@carbon/contracts/plugin/extension-points";

import { parsePluginDeclaration } from "../../domain/entities/PluginDeclaration.ts";
import { PluginManifest } from "../../domain/entities/PluginManifest.ts";
import { NotAPluginDirectoryError } from "../../domain/errors/PluginError.ts";
import { DEFAULT_LANGUAGE } from "../../domain/value-objects/PluginLanguage.ts";
import type { PluginWorkspace } from "../ports/PluginWorkspace.ts";

export type FindingSeverity = "error" | "warning";

export interface CheckFinding {
  readonly severity: FindingSeverity;
  readonly message: string;
  /** What to do about it, when there is a single obvious answer. */
  readonly fix?: string;
}

export interface CheckPluginResult {
  readonly directory: string;
  readonly name: string;
  /** Points that resolved against the registry. */
  readonly points: readonly ExtensionPointSpec[];
  readonly findings: readonly CheckFinding[];
  readonly ok: boolean;
}

export class CheckPluginUseCase {
  constructor(private readonly workspace: PluginWorkspace) {}

  execute(directory: string): CheckPluginResult {
    // A plugin is a Zig project. Checking a directory that is not one is a
    // mistake worth naming before anything else, because every finding below
    // would otherwise be "nothing declared".
    if (!this.workspace.exists(join(directory, DEFAULT_LANGUAGE.marker))) {
      throw new NotAPluginDirectoryError(directory);
    }

    const manifestPath = join(directory, "carbon-plugin.toml");
    const findings: CheckFinding[] = [];

    if (!this.workspace.exists(manifestPath)) {
      return {
        directory,
        name: "",
        points: [],
        findings: [
          {
            severity: "error",
            message: "no carbon-plugin.toml — the toolchain cannot tell what this plugin declares",
            fix: "carbon plugin new <name> scaffolds one, or copy the template from the SDK",
          },
        ],
        ok: false,
      };
    }

    const toml = this.workspace.readFile(manifestPath);
    const manifest = PluginManifest.parse(toml);
    const declaration = parsePluginDeclaration(toml);

    const points: ExtensionPointSpec[] = [];
    for (const id of declaration.extensionPoints) {
      const spec = extensionPoint(id);
      if (!spec) {
        findings.push({
          severity: "error",
          message: `extension point "${id}" does not exist`,
          fix: `known points: ${EXTENSION_POINT_IDS.join(", ")}`,
        });
        continue;
      }
      points.push(spec);

      // A point that gates on a capability the manifest does not request is a
      // plugin that will be refused at load. The Zig SDK derives this list, so
      // hitting it means the .toml and the comptime manifest have diverged —
      // which is exactly what this command exists to catch.
      if (spec.capability && !declaration.requiredCapabilities.includes(spec.capability)) {
        findings.push({
          severity: "error",
          message:
            `"${id}" needs the "${spec.capability}" capability, ` +
            "which this manifest does not require",
          fix: `add "${spec.capability}" to [capabilities] required in carbon-plugin.toml`,
        });
      }

      if (spec.stability === "experimental") {
        findings.push({
          severity: "warning",
          message: `"${id}" is experimental and may change or disappear within ABI major 1`,
        });
      }
    }

    if (declaration.extensionPoints.length === 0) {
      findings.push({
        severity: "warning",
        message: "no extension points declared — this plugin would load and do nothing",
        fix: 'the usual minimum is extension-points = ["lifecycle.register"]',
      });
    }

    // A capability nothing needs is not an error — a plugin may want it for
    // its own work, like the clipboard one does — but it is worth surfacing,
    // because the other reason to see one is a typo'd point id above.
    for (const capability of declaration.requiredCapabilities) {
      const needed = points.some((point) => point.capability === capability);
      if (!needed) {
        findings.push({
          severity: "warning",
          message:
            `capability "${capability}" is required but no declared extension point needs it`,
          fix: "fine if the plugin uses it directly; otherwise remove it",
        });
      }
    }

    return {
      directory,
      name: manifest.name.slug,
      points,
      findings,
      ok: !findings.some((f) => f.severity === "error"),
    };
  }
}
