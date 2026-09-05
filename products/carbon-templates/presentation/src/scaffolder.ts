// Scaffolder presentation helper

import { ScaffolderEngine } from "../../infrastructure/services/ScaffolderEngine.ts";
import { TemplateRegistry, type AppTemplate } from "../../infrastructure/services/TemplateRegistry.ts";

export function listAvailableTemplates(): AppTemplate[] {
  return TemplateRegistry.getInstance().list();
}

export async function scaffoldTemplate(templateId: string, targetDir: string, appName: string) {
  return await ScaffolderEngine.getInstance().scaffold({
    templateId,
    targetDir,
    appName,
  });
}
