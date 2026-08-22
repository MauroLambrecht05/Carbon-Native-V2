// Scaffolding a new native plugin.

import { join, relative } from "node:path";
import { TargetNotEmptyError, UnknownLanguageError } from "../../domain/errors/PluginError.ts";
import {
  DEFAULT_LANGUAGE,
  languageNamed,
  LANGUAGES,
} from "../../domain/value-objects/PluginLanguage.ts";
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
    const language = request.language ? languageNamed(request.language) : DEFAULT_LANGUAGE;
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

    // The SDK package root: where the scaffolded build.zig.zon points its
    // `carbon-plugin-sdk` dependency.
    //
    // `composition/`, because that is where build.zig lives — a Zig package IS
    // its build.zig, and the SDK's is its composition root. This used to join
    // `language.id`, i.e. `<sdkRoot>/zig`, which was right while the SDK was
    // solutions/capabilities/plugin-sdk/zig/ and pointed at nothing once it
    // became products/carbon-ext. Naming the directory rather than deriving it
    // from the language is also honest: there is one language, and where its
    // package definition sits is not a property of the language.
    //
    // Zig does not accept a backslash in a dependency path, so it is
    // forward-slashed regardless of platform.
    const sdkPath = forwardSlashes(
      relative(target, join(request.sdkRoot, "composition")) || ".",
    );

    const files = this.templates.filesFor({ name, language, sdkPath });

    this.workspace.createDirectory(target);
    for (const file of files) {
      this.workspace.writeFile(join(target, file.path), file.contents);
    }

    const nextStep = `cd ${name.slug} && carbon plugin build --release && carbon plugin install`;

    return { name, target, language: language.id, files, nextStep };
  }
}
