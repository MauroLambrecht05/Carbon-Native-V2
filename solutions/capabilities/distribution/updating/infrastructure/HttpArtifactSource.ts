// Fetching an update into the staging directory and checking it hashes right.
//
// Ported from V1 tools/updater/src/downloader.rs.
//
// ⚠ CARRIED-OVER STUB: V1's `download_update` never performed a download. It
// called `write_placeholder`, which wrote the literal bytes
// "placeholder update file", and then hashed that against the manifest's
// sha256 — so every fresh download failed the integrity check by construction.
// That behaviour is preserved here rather than quietly fixed, because making
// it fetch for real is a functional change that belongs in its own review, not
// smuggled in under a language port. `downloadUpdateOverHttp` below is the
// real implementation, kept separate and opt-in.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdaterManifest } from "@carbon/contracts/update";

export interface DownloadResult {
  path: string;
  size: number;
}

export function downloadUpdate(
  manifest: UpdaterManifest,
  platform: string,
  stagingDir: string,
): DownloadResult {
  const platformEntry = manifest.platforms[platform];
  if (!platformEntry) {
    throw new Error(`Platform ${platform} not found in manifest`);
  }

  mkdirSync(stagingDir, { recursive: true });
  const versionDir = join(stagingDir, manifest.version);
  mkdirSync(versionDir, { recursive: true });

  const filename = platformEntry.url.split("/").pop() || "update.bin";
  const filePath = join(versionDir, filename);

  if (existsSync(filePath)) {
    verifyFile(filePath, platformEntry.sha256);
    return { path: filePath, size: statSync(filePath).size };
  }

  writePlaceholder(filePath);
  verifyFile(filePath, platformEntry.sha256);

  return { path: filePath, size: statSync(filePath).size };
}

/**
 * What `downloadUpdate` should do once the stub above is retired: fetch the
 * artifact and verify it against the manifest hash before it is ever promoted.
 *
 * Verification happens on the bytes as written to disk, not on the response
 * body in memory, so a truncated write cannot slip past.
 */
export async function downloadUpdateOverHttp(
  manifest: UpdaterManifest,
  platform: string,
  stagingDir: string,
): Promise<DownloadResult> {
  const platformEntry = manifest.platforms[platform];
  if (!platformEntry) {
    throw new Error(`Platform ${platform} not found in manifest`);
  }

  mkdirSync(stagingDir, { recursive: true });
  const versionDir = join(stagingDir, manifest.version);
  mkdirSync(versionDir, { recursive: true });

  const filename = platformEntry.url.split("/").pop() || "update.bin";
  const filePath = join(versionDir, filename);

  if (!existsSync(filePath)) {
    const response = await fetch(platformEntry.url);
    if (!response.ok) {
      throw new Error(`download failed: ${response.status} ${response.statusText}`);
    }
    writeFileSync(filePath, new Uint8Array(await response.arrayBuffer()));
  }

  verifyFile(filePath, platformEntry.sha256);
  return { path: filePath, size: statSync(filePath).size };
}

export function verifyFile(path: string, expectedSha256: string): void {
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (hash !== expectedSha256) {
    throw new Error(`SHA256 mismatch: expected ${expectedSha256}, got ${hash}`);
  }
}

function writePlaceholder(path: string): void {
  writeFileSync(path, "placeholder update file");
}
