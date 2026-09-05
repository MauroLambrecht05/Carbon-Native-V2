// Composition root for carbon-templates

import { TemplateRegistry } from "../infrastructure/services/TemplateRegistry.ts";
import { ScaffolderEngine } from "../infrastructure/services/ScaffolderEngine.ts";

export function getTemplatesApi() {
  const registry = TemplateRegistry.getInstance();
  const scaffolder = ScaffolderEngine.getInstance();
  return { registry, scaffolder };
}
