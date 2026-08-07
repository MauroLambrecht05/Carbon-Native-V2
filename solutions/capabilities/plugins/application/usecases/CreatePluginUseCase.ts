// Scaffolding a new native plugin.

import { join, relative } from "node:path";
import { TargetNotEmptyError, UnknownLanguageError } from "../../domain/errors/PluginError.ts";
import { languageNamed, LANGUAGES, RUST } from "../../domain/value-objects/PluginLanguage.ts";
import { PluginName } from "../../domain/value-objects/PluginName.ts";
import type {
  PluginTemplateFile,
  PluginTemplateSource,
  PluginWorkspace,
} from "../ports/PluginWorkspace.ts";

export interface CreatePluginRequest {
  readonly name: string;
  readonly language?: string;
  readonly cwd: string;
  /** Absolute path to the plugin SDK the generated project depends on. */
  readonly sdkRoot: string;
}

export interface CreatePluginResult {
  readonly name: PluginName;
  readonly target: string;
  readonly language: string;
  readonly files: readonly PluginTemplateFile[];
  /** The command to run next, which differs by language. */
  readonly nextStep: string;
}

/** Paths inside generated build files must be forward-slashed, even on Windows. */
export function forwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

export class CreatePluginUseCase {
  constructor(
    private readonly workspace: PluginWorkspace,
    private readonly templates: PluginTemplateSource,
  ) {}

  execute(request: CreatePluginRequest): CreatePluginResult {
    const language = request.language ? languageNamed(request.language) : RUST;
    if (!language) {
      throw new UnknownLanguageError(
        request.language!,
        LANGUAGES.map((l) => l.id),
      );
    }

    const name = PluginName.from(request.name);
    const target = join(request.cwd, name.slug);
    if (!this.workspace.isEmptyDirectory(target)) {
      throw new TargetNotEmptyError(target);
    }

    // Neither Cargo nor Zig accepts a backslash in a dependency path, so the
    // SDK path is forward-slashed regardless of platform.
    const sdkPath = forwardSlashes(
      relative(target, join(request.sdkRoot, language.id)) || ".",
    );

    const files = this.templates.filesFor({ name, language, sdkPath });

    this.workspace.createDirectory(target);
    for (const file of files) {
      this.workspace.writeFile(join(target, file.path), file.contents);
    }

    const nextStep =
      language.id === "rust"
        ? `cd ${name.slug} && carbon plugin build --release && carbon plugin install`
        : `cd ${name.slug} && zig build && carbon plugin install`;

    return { name, target, language: language.id, files, nextStep };
  }
}
