// The real filesystem.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PackageWriter } from "../application/ports/PackageWriter.ts";

export class NodePackageWriter implements PackageWriter {
  createDirectory(path: string): void {
    mkdirSync(path, { recursive: true });
  }

  writeFile(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
}
