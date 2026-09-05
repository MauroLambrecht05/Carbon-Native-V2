// Scaffolder Engine: Copies template files and replaces placeholder variables.

import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { TemplateRegistry } from "./TemplateRegistry.ts";

export interface ScaffoldOptions {
  readonly templateId: string;
  readonly targetDir: string;
  readonly appName: string;
}

export class ScaffolderEngine {
  private static instance: ScaffolderEngine;
  private readonly registry = TemplateRegistry.getInstance();

  static getInstance(): ScaffolderEngine {
    if (!ScaffolderEngine.instance) {
      ScaffolderEngine.instance = new ScaffolderEngine();
    }
    return ScaffolderEngine.instance;
  }

  async scaffold(options: ScaffoldOptions): Promise<{ templateName: string; createdFiles: string[] }> {
    const template = this.registry.get(options.templateId);
    if (!template) {
      const available = this.registry.list().map((t) => t.id).join(", ");
      throw new Error(`Template "${options.templateId}" not found. Available templates: ${available}`);
    }

    const createdFiles: string[] = [];

    for (const [relPath, content] of Object.entries(template.files)) {
      const substitutedPath = relPath.replace(/\{\{APP_NAME\}\}/g, options.appName);
      const fullPath = join(options.targetDir, substitutedPath);
      const substitutedContent = content.replace(/\{\{APP_NAME\}\}/g, options.appName);

      await mkdir(dirname(fullPath), { recursive: true });
      await Bun.write(fullPath, substitutedContent);
      createdFiles.push(fullPath);
    }

    return {
      templateName: template.name,
      createdFiles,
    };
  }
}
