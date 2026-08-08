// Plugin templates, read from the SDK on disk.
//
// Read rather than embedded — the opposite of the project templates in
// @carbon/scaffolding — and the difference is deliberate. Project templates
// have exactly one producer, this toolchain. Plugin templates have two: the
// Rust CLI used include_str! against the same files, and the moment either side
// embeds its own copy they drift, silently, into producing different plugins
// for the same command.
//
// The SDK lives in solutions/capabilities/plugin-sdk, which holds the Rust and
// Zig libraries a plugin compiles against plus the templates a new plugin is
// generated from.
//
// It pointed at <workspace>/packages/carbon-sdk until the SDK was migrated — a
// V1 directory that had not existed since, so `carbon plugin new` failed on a
// missing template file.

import { join } from "node:path";
import type {
  PluginTemplateFile,
  PluginTemplateRequest,
  PluginTemplateSource,
} from "../application/ports/PluginWorkspace.ts";
import type { PluginWorkspace } from "../application/ports/PluginWorkspace.ts";

/** Where the SDK lives, relative to the workspace root. */
export function sdkRootFor(workspaceRoot: string): string {
  return join(workspaceRoot, "solutions", "capabilities", "plugin-sdk");
}

/**
 * Which template produces which file, per language.
 *
 * A table rather than two code paths: adding a language is a row, and the two
 * languages cannot drift in how they render.
 */
const LAYOUT: Record<string, Array<{ template: string; output: string }>> = {
  rust: [
    { template: "rust/templates/plugin/Cargo.toml.tmpl", output: "Cargo.toml" },
    { template: "rust/templates/plugin/src/lib.rs.tmpl", output: "src/lib.rs" },
    { template: "rust/templates/plugin/carbon-plugin.toml.tmpl", output: "carbon-plugin.toml" },
  ],
  zig: [
    { template: "zig/templates/plugin/build.zig.tmpl", output: "build.zig" },
    { template: "zig/templates/plugin/build.zig.zon.tmpl", output: "build.zig.zon" },
    { template: "zig/templates/plugin/src/main.zig.tmpl", output: "src/main.zig" },
    { template: "zig/templates/plugin/carbon-plugin.toml.tmpl", output: "carbon-plugin.toml" },
  ],
};

export class SdkTemplateSource implements PluginTemplateSource {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly sdkRoot: string,
  ) {}

  filesFor(request: PluginTemplateRequest): PluginTemplateFile[] {
    const entries = LAYOUT[request.language.id] ?? [];

    return entries.map(({ template, output }) => {
      const raw = this.workspace.readFile(join(this.sdkRoot, template));
      return { path: output, contents: render(raw, output, request) };
    });
  }
}

/**
 * Resolves the placeholders in one template.
 *
 * @@NAME@@ means different things depending on the file, and this is not a
 * quirk worth normalising away: manifests name the plugin `my-thing`, but
 * `my-thing` is not a legal Rust or Zig identifier, so the generated sources
 * need `my_thing`. V1 drew the line at source files and the SDK templates are
 * written against that, so the line stays where it is.
 */
function render(template: string, output: string, request: PluginTemplateRequest): string {
  const name = isSourceFile(output) ? request.name.crate : request.name.slug;
  return template
    .replaceAll("@@NAME@@", name)
    .replaceAll("@@CRATE@@", request.name.crate)
    .replaceAll("@@SDK_PATH@@", request.sdkPath);
}

/** Source files take the crate name in @@NAME@@; everything else takes the slug. */
export function isSourceFile(output: string): boolean {
  return output.startsWith("src/");
}
