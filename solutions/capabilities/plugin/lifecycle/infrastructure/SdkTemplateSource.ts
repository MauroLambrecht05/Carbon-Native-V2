// Plugin templates, read from the SDK on disk.
//
// Read rather than embedded — the opposite of the project templates in
// @carbon/scaffolding — and the difference is deliberate. Project templates
// have exactly one producer, this toolchain. Plugin templates have two: the
// Rust CLI used include_str! against the same files, and the moment either side
// embeds its own copy they drift, silently, into producing different plugins
// for the same command.
//
// ── WHERE THE SDK IS, AND WHY THIS DOES NOT SAY ─────────────────────────────
// The templates live in `products/carbon-ext/presentation/templates`, because
// what a scaffolded plugin looks like is the SDK's surface — and this is a
// SOLUTION. Solutions may not name a path inside a product; products depend on
// solutions and never the other way round.
//
// So the root is INJECTED. `carbon-cli` knows where carbon-ext is and passes
// it in, and this adapter only knows how to read templates out of whatever
// root it was handed. That is also what makes it testable against a fake.
//
// It used to derive the path itself via `sdkRootFor(workspaceRoot)`, which was
// fine while the SDK was a capability and wrong the moment it became a
// product.

import { join } from "node:path";
import type {
  PluginTemplateFile,
  PluginTemplateRequest,
  PluginTemplateSource,
} from "../application/ports/PluginWorkspace.ts";
import type { PluginWorkspace } from "../application/ports/PluginWorkspace.ts";

/**
 * Which template produces which file, per language.
 *
 * Still a table with the language as its key, though there is one language
 * now. The shape is what let Rust be removed as a data edit rather than an
 * unpicking of two code paths, and it is what a second language would go back
 * into — the cost of keeping it is one line.
 */
const LAYOUT: Record<string, Array<{ template: string; output: string }>> = {
  zig: [
    { template: "presentation/templates/plugin/build.zig.tmpl", output: "build.zig" },
    { template: "presentation/templates/plugin/build.zig.zon.tmpl", output: "build.zig.zon" },
    { template: "presentation/templates/plugin/src/main.zig.tmpl", output: "src/main.zig" },
    { template: "presentation/templates/plugin/carbon-plugin.toml.tmpl", output: "carbon-plugin.toml" },
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
 * `my-thing` is not a legal Zig identifier, so the generated sources need
 * `my_thing`. V1 drew the line at source files and the SDK templates are
 * written against that, so the line stays where it is.
 */
function render(template: string, output: string, request: PluginTemplateRequest): string {
  const name = isSourceFile(output) ? request.name.crate : request.name.slug;
  return template
    .replaceAll("@@NAME@@", name)
    .replaceAll("@@CRATE@@", request.name.crate)
    .replaceAll("@@SDK_PATH@@", request.sdkPath);
}

/** Source files take the identifier form in @@NAME@@; everything else the slug. */
export function isSourceFile(output: string): boolean {
  return output.startsWith("src/");
}
