// The real filesystem.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PluginWorkspace } from "../application/ports/PluginWorkspace.ts";

export class NodePluginWorkspace implements PluginWorkspace {
  exists(path: string): boolean {
    return existsSync(path);
  }

  isEmptyDirectory(path: string): boolean {
    if (!existsSync(path)) return true;
    try {
      return readdirSync(path).length === 0;
    } catch {
      return false;
    }
  }

  readFile(path: string): string {
    return readFileSync(path, "utf8");
  }

  writeFile(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  createDirectory(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  copyFile(from: string, to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  findHostApp(from: string): string | null {
    let current = from;
    // Terminates at the filesystem root, where dirname() is a fixed point.
    while (true) {
      if (existsSync(join(current, "carbon.toml"))) return current;
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}
