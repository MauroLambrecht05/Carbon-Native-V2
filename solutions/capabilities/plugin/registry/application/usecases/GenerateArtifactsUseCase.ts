// Write the renderings.

import type { ArtifactStore } from "../ports/ArtifactStore.ts";
import { RenderRegistryUseCase, type Rendering } from "./RenderRegistryUseCase.ts";

export interface GeneratedArtifact extends Rendering {
  /** False when the file on disk already had exactly these bytes. */
  readonly changed: boolean;
}

export interface GenerateResult {
  readonly artifacts: readonly GeneratedArtifact[];
  readonly pointCount: number;
  readonly abiMinor: number;
}

export class GenerateArtifactsUseCase {
  constructor(private readonly store: ArtifactStore) {}

  execute(): GenerateResult {
    const { registry, renderings } = new RenderRegistryUseCase(this.store).execute();

    const artifacts = renderings.map((rendering) => {
      const existing = this.store.readArtifact(rendering.path);
      const changed = existing !== rendering.contents;
      // Written unconditionally rather than only when changed: a file whose
      // bytes match but whose mtime is older than the registry still looks
      // stale to a build system, and rewriting three small files costs
      // nothing. `changed` is reported so the OUTPUT stays honest.
      this.store.writeArtifact(rendering.path, rendering.contents);
      return { ...rendering, changed };
    });

    return {
      artifacts,
      pointCount: registry.points.length,
      abiMinor: registry.impliedAbiMinor,
    };
  }
}
