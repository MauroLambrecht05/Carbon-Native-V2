// The real filesystem.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProjectFileSystem } from "../application/ports/ProjectFileSystem.ts";

export class NodeProjectFileSystem implements ProjectFileSystem {
  isEmptyDirectory(path: string): boolean {
    if (!existsSync(path)) return true;
    try {
      return readdirSync(path).length === 0;
    } catch {
      // Exists but unreadable — a permission error, or not a directory at all.
      // Report it as non-empty so scaffolding refuses rather than writing into
      // something it could not inspect.
      return false;
    }
  }

  createDirectory(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  writeFile(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}
