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
import { GITIGNORE, TSCONFIG_JSON } from "./templates/project-files.ts";

function render(template: string, request: TemplateRequest): string {
  return template
    .replace(/@@NAME@@/g, request.name.slug)
    .replace(/@@DISPLAY@@/g, request.name.display)
    .replace(/@@ROOT@@/g, request.packagesPath);
}

export class EmbeddedTemplateSource implements TemplateSource {
  filesFor(request: TemplateRequest): PlannedFile[] {
    // The backend is substituted after rendering rather than being another
    // placeholder, because every manifest template carries a real default
    // (`backend = "mini"`) — which keeps the templates readable as valid TOML.
    const manifest = render(manifestTemplate(request.preset.manifest), request).replace(
      'backend = "mini"',
      `backend = "${request.backend}"`,
    );

    return [
      { path: "carbon.toml", contents: manifest },
      { path: "package.json", contents: render(packageJsonTemplate(request.preset.name), request) },
      { path: "App.tsx", contents: render(appTsxTemplate(request.preset.styling), request) },
      // Rendered, not raw: the tsconfig carries @@ROOT@@ now, so that the
      // editor can resolve @carbon/mini-solid from the workspace.
      { path: "tsconfig.json", contents: render(TSCONFIG_JSON, request) },
      { path: ".gitignore", contents: GITIGNORE },
    ];
  }
}
