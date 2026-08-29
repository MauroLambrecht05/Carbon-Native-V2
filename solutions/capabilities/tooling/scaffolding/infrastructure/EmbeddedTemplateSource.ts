// The built-in templates, compiled into the binary.
//
// The @@PLACEHOLDER@@ convention is inherited from V1's Rust CLI, which used
// the same markers with include_str!. It survives here because it is invisible
// to every tool that might touch the templates: a `.tsx` template with
// @@DISPLAY@@ in it is still valid enough to read, whereas ${...} would be
// interpolated by the very template literal holding it.

import type { PlannedFile } from "../domain/entities/ProjectPlan.ts";
import type { TemplateRequest, TemplateSource } from "../application/ports/TemplateSource.ts";
import { manifestTemplate } from "./templates/manifest.ts";
import { packageJsonTemplate } from "./templates/package-json.ts";
import { appTsxTemplate } from "./templates/app-tsx.ts";
import { tsconfigTemplate, GITIGNORE } from "./templates/project-files.ts";

function render(template: string, request: TemplateRequest): string {
  // @@ROOT@@ is the workspace root placeholder — relative (../../..) for
  // projects inside the workspace, absolute for standalone installs.
  return template
    .replace(/@@ROOT@@/g, request.packagesPath)
    .replace(/@@NAME@@/g, request.name.slug)
    .replace(/@@DISPLAY@@/g, request.name.display);
}

export class EmbeddedTemplateSource implements TemplateSource {
  filesFor(request: TemplateRequest): PlannedFile[] {
    const { preset } = request;

    const manifest = render(manifestTemplate(preset.manifest), request).replace(
      'backend = "mini"',
      `backend = "${request.backend}"`,
    );

    const tsconfig = render(tsconfigTemplate(preset.renderer), request);
    const { app, main } = appTsxTemplate(preset.renderer, preset.styling);

    return [
      { path: "carbon.toml",   contents: manifest },
      { path: "package.json",  contents: render(packageJsonTemplate(preset.name), request) },
      { path: "App.tsx",       contents: render(app, request) },
      { path: "main.tsx",      contents: render(main, request) },
      { path: "tsconfig.json", contents: tsconfig },
      { path: ".gitignore",    contents: GITIGNORE },
    ];
  }
}
