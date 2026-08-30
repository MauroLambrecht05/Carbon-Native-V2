// Scaffold carbon/build.zig + build.zig.zon (once) for a host app.
//
// Shared by CreatePluginUseCase (`carbon plugin new`) and InstallPluginUseCase
// (`carbon plugin add`/`install`) — whichever one is a HOST APP's first ever
// plugin interaction is responsible for this, so both call it rather than
// one assuming the other already ran. Idempotent: a `carbon/build.zig`
// that's already there (hand-edited or not) is never touched.
//
// manifest.toml itself is NOT scaffolded here — each caller writes its own
// first entry into it immediately after, via upsertManifestEntry, which
// creates the file from nothing just as happily as it updates one.

import { join } from "node:path";
import type { PluginTemplateSource, PluginWorkspace } from "../ports/PluginWorkspace.ts";

export function ensureAppCarbonDir(
  workspace: PluginWorkspace,
  templates: PluginTemplateSource,
  host: string,
): void {
  const carbonDir = join(host, "carbon");
  if (workspace.exists(join(carbonDir, "build.zig"))) return;
  for (const file of templates.appCarbonDirFiles()) {
    if (file.path === "manifest.toml") continue; // the caller writes this immediately after
    workspace.writeFile(join(carbonDir, file.path), file.contents);
  }
}
