// Reads carbon.toml off disk.
//
// The manifest *rules* belong to the entity; this only gets bytes and hands
// them over. That is the whole point of the split: validateManifest can be
// exercised against a literal with no filesystem and no TOML parser.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  MANIFEST_FILENAME,
  validateManifest,
  type CarbonConfig,
} from "@carbon/contracts/app";
import { ConfigError } from "@carbon/contracts/app/errors";
import type { ManifestRepository } from "../ports/ManifestRepository.ts";

export class TomlManifestRepository implements ManifestRepository {
  pathFor(projectDir: string): string {
    return join(projectDir, MANIFEST_FILENAME);
  }

  exists(projectDir: string): boolean {
    return existsSync(this.pathFor(projectDir));
  }

  load(projectDir: string): CarbonConfig {
    const path = this.pathFor(projectDir);
    if (!existsSync(path)) {
      throw new ConfigError(
        "no " + MANIFEST_FILENAME + " in " + projectDir + ". Run `carbon init` to create one.",
      );
    }

    let parsed: Record<string, any>;
    try {
      parsed = parseToml(readFileSync(path, "utf8")) as Record<string, any>;
    } catch (e: any) {
      throw new ConfigError(`parse error: ${e.message}`, path);
    }

    return validateManifest(parsed, path);
  }
}

// The default instance, plus the function-shaped surface the ported V1 call
// sites use. Kept so ~10 imports of `loadCarbonConfig` did not have to change
// when the repository seam went in.
const defaultRepository = new TomlManifestRepository();

export const manifestPath = (projectDir: string) => defaultRepository.pathFor(projectDir);
export const hasManifest = (projectDir: string) => defaultRepository.exists(projectDir);
export const loadCarbonConfig = (projectDir: string) => defaultRepository.load(projectDir);

/** @deprecated kept for call sites that awaited this; loading is synchronous. */
export async function loadConfig(projectDir: string = "."): Promise<CarbonConfig> {
  return defaultRepository.load(projectDir);
}

export { MANIFEST_FILENAME, ConfigError };
export type { CarbonConfig };
