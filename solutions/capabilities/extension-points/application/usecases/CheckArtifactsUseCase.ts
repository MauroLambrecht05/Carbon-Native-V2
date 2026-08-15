// Are the checked-in renderings still what the registry says?
//
// This is the check with teeth in the whole architecture. Three languages hold
// a copy of one agreement; the only thing keeping them honest is that this runs
// in CI and fails when they diverge. Without it, the Zig file becomes
// documentation and the real contract becomes whatever the Rust happens to say
// — which is precisely the failure `check_host_boundary.py` was written for
// one boundary over.

import type { ArtifactStore } from "../ports/ArtifactStore.ts";
import { RenderRegistryUseCase } from "./RenderRegistryUseCase.ts";

export type ArtifactStatus = "current" | "stale" | "missing";

export interface CheckedArtifact {
  readonly path: string;
  readonly status: ArtifactStatus;
  /** First line that differs, 1-indexed. Undefined when the file is missing. */
  readonly firstDifferingLine?: number;
}

export interface CheckResult {
  readonly artifacts: readonly CheckedArtifact[];
  readonly pointCount: number;
  readonly ok: boolean;
  /** Just the paths that need regenerating — what the error message wants. */
  readonly outOfDate: readonly string[];
}

export class CheckArtifactsUseCase {
  constructor(private readonly store: ArtifactStore) {}

  execute(): CheckResult {
    const { registry, renderings } = new RenderRegistryUseCase(this.store).execute();

    const artifacts = renderings.map<CheckedArtifact>((rendering) => {
      const existing = this.store.readArtifact(rendering.path);
      if (existing === null) {
        return { path: rendering.path, status: "missing" };
      }
      if (existing === rendering.contents) {
        return { path: rendering.path, status: "current" };
      }
      return {
        path: rendering.path,
        status: "stale",
        firstDifferingLine: firstDifference(existing, rendering.contents),
      };
    });

    const outOfDate = artifacts.filter((a) => a.status !== "current").map((a) => a.path);

    return {
      artifacts,
      pointCount: registry.points.length,
      ok: outOfDate.length === 0,
      outOfDate,
    };
  }
}

/**
 * The 1-indexed line where two texts first differ.
 *
 * Reported because "this file is stale" sends someone to a 400-line generated
 * artifact with no idea what moved; a line number turns it into a diff they can
 * read in one jump.
 */
function firstDifference(a: string, b: string): number {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const shared = Math.min(aLines.length, bLines.length);

  for (let i = 0; i < shared; i++) {
    if (aLines[i] !== bLines[i]) return i + 1;
  }
  // No differing line in the shared prefix, so one is a prefix of the other and
  // the difference is the first line only the longer one has.
  return shared + 1;
}
