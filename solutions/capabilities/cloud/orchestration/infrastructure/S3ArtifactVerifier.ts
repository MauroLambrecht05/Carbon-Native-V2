import type { ArtifactVerifier } from '../application/ports/PlatformBuildRepository.ts';

export interface ArtifactStoreConfig { readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string }

/** Reads a declared artifact back from S3-compatible storage and compares its size and SHA-256. */
export class S3ArtifactVerifier implements ArtifactVerifier {
  private readonly client: Bun.S3Client;
  constructor(config: ArtifactStoreConfig) { this.client = new Bun.S3Client({ endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }); }

  async verify(artifact: { readonly objectKey: string; readonly sizeBytes: number; readonly sha256: string }): Promise<boolean> {
    const file = this.client.file(artifact.objectKey);
    if (!await file.exists()) return false;
    if ((await file.stat()).size !== artifact.sizeBytes) return false;
    // Hash the stored bytes themselves; a checksum the uploader supplied proves nothing.
    const hasher = new Bun.CryptoHasher('sha256'); let read = 0;
    for await (const chunk of file.stream() as unknown as AsyncIterable<Uint8Array>) { read += chunk.byteLength; if (read > artifact.sizeBytes) return false; hasher.update(chunk); }
    return read === artifact.sizeBytes && hasher.digest('hex') === artifact.sha256;
  }
}
