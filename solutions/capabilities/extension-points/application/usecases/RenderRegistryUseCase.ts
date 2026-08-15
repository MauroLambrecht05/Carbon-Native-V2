// Turning the registry into its three renderings.
//
// The one place that knows there ARE three, so `generate` and `check` cannot
// disagree about which artifacts exist — a check that verifies two of three is
// worse than no check, because it reports success.

import { parseZigRegistry } from "../../domain/services/ZigRegistryParser.ts";
import type { ExtensionPointRegistry } from "../../domain/entities/ExtensionPoint.ts";
import { C_HEADER_PATH, renderCHeader } from "../../domain/services/renderers/CHeaderRenderer.ts";
import { RUST_PATH, renderRust } from "../../domain/services/renderers/RustRenderer.ts";
import {
  TYPESCRIPT_PATH,
  renderTypeScript,
} from "../../domain/services/renderers/TypeScriptRenderer.ts";
import type { ArtifactStore } from "../ports/ArtifactStore.ts";

export interface Rendering {
  /** Workspace-relative, forward slashes — it appears in error messages. */
  readonly path: string;
  readonly contents: string;
  /** What the file is for, one line, for `carbon ext generate` output. */
  readonly purpose: string;
}

export interface RenderResult {
  readonly registry: ExtensionPointRegistry;
  readonly renderings: readonly Rendering[];
}

export class RenderRegistryUseCase {
  constructor(private readonly store: ArtifactStore) {}

  execute(): RenderResult {
    const registry = parseZigRegistry(this.store.readRegistry());

    return {
      registry,
      renderings: [
        {
          path: C_HEADER_PATH,
          contents: renderCHeader(registry),
          purpose: "what a plugin author compiles against",
        },
        {
          path: RUST_PATH,
          contents: renderRust(registry),
          purpose: "the table the runtime dispatches through",
        },
        {
          path: TYPESCRIPT_PATH,
          contents: renderTypeScript(registry),
          purpose: "what the toolchain validates manifests with",
        },
      ],
    };
  }
}
