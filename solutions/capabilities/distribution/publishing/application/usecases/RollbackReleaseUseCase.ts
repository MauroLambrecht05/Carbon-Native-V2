// Use case: point a channel back at a version it already published.
//
// Deliberately needs no signing key. PublishReleaseUseCase saves a per-version
// manifest snapshot (releases/<version>/manifest.{json,sig}) alongside every
// channel-pointer update specifically so this could just re-point the
// channel at bytes that are already validly signed, instead of re-signing —
// re-signing would mean every rollback needs the private key on hand, which
// is a worse operational story than "read two objects, write two objects."

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@carbon/logging";
import type { UpdaterManifest } from "@carbon/contracts/update";
import { uploadManifestTo, fetchReleaseManifest, type S3Config } from "../../infrastructure/S3ArtifactStore.ts";

export interface RollbackReleaseRequest {
  readonly channel: string;
  readonly toVersion: string;
}

export interface RollbackReleaseResult {
  readonly manifest: UpdaterManifest;
  readonly manifestUrl: string;
}

export class RollbackReleaseUseCase {
  constructor(
    private readonly s3: S3Config,
    private readonly logger?: Logger,
  ) {}

  async execute(request: RollbackReleaseRequest): Promise<RollbackReleaseResult> {
    const snapshot = await fetchReleaseManifest(this.s3, request.toVersion);
    if (!snapshot) {
      throw new Error(
        `no published manifest snapshot found for version ${request.toVersion} — it was either never ` +
          `published through \`carbon publish app\`, or predates this pipeline's snapshot support`,
      );
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "carbon-rollback-"));
    try {
      const manifestPath = join(tmpDir, "manifest.json");
      const sigPath = join(tmpDir, "manifest.sig");
      writeFileSync(manifestPath, snapshot.json);
      writeFileSync(sigPath, snapshot.sig);

      const upload = await uploadManifestTo(this.s3, manifestPath, sigPath, request.channel, this.logger);
      if (!upload.manifest.success || !upload.signature.success) {
        throw new Error(
          `rollback upload failed: ${upload.manifest.error ?? upload.signature.error ?? "unknown error"}`,
        );
      }

      return { manifest: snapshot.manifest, manifestUrl: upload.manifest.url };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
