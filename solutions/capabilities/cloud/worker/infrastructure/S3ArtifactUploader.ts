// ArtifactUploader over @carbon/publishing's S3 client — the same one
// products/carbon-cloud uses to host the update manifest, so a worker's
// build artifacts and the manifest that points at them live in the same
// bucket under the same credentials.

import { uploadToS3, type S3Config } from "@carbon/publishing";
import type { Logger } from "@carbon/logging";
import type { ArtifactUploader, UploadedArtifact } from "../application/ports/ArtifactUploader.ts";

export class UploadFailedError extends Error {
  constructor(readonly localPath: string, readonly reason: string) {
    super(`upload of ${localPath} failed: ${reason}`);
  }
}

export class S3ArtifactUploader implements ArtifactUploader {
  constructor(private readonly config: S3Config, private readonly logger?: Logger) {}

  async upload(localPath: string, remoteKey: string): Promise<UploadedArtifact> {
    const result = await uploadToS3(this.config, localPath, remoteKey, this.logger);
    if (!result.success) throw new UploadFailedError(localPath, result.error ?? "unknown error");
    return { url: result.url };
  }
}
