// The real filesystem, rooted at the workspace.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ExtensionPointError } from "../domain/errors/ExtensionPointError.ts";
import type { ArtifactStore } from "../application/ports/ArtifactStore.ts";

/** Workspace-relative path of the Zig registry — the source of truth. */
export const REGISTRY_PATH = "solutions/contracts/plugin/registry/extension-points.zig";

/**
 * Line endings, normalised on the way in AND on the way out.
 *
 * `check` compares a file on disk against a freshly rendered string. Without
 * this, a checkout with git's `autocrlf` on reports all three artifacts stale
 * from line 1 — a true statement about the bytes and a useless one about the
 * contract, which is what is actually being compared.
 */
function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export class NodeArtifactStore implements ArtifactStore {
  constructor(private readonly workspaceRoot: string) {}

  readRegistry(): string {
    const path = join(this.workspaceRoot, REGISTRY_PATH);
    if (!existsSync(path)) {
      throw new ExtensionPointError(
        `no extension-point registry at ${REGISTRY_PATH}\n` +
          `  looked under: ${this.workspaceRoot}`,
      );
    }
    return lf(readFileSync(path, "utf8"));
  }

  readArtifact(relativePath: string): string | null {
    const path = join(this.workspaceRoot, relativePath);
    if (!existsSync(path)) return null;
    return lf(readFileSync(path, "utf8"));
  }

  writeArtifact(relativePath: string, contents: string): void {
    const path = join(this.workspaceRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lf(contents), "utf8");
  }
}
