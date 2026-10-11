import type { RegistryArchiveStore } from '../application/ports/RegistryPackages.ts';

export interface RegistryArchiveStoreConfig { readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string }

/** Archive bytes in an S3-compatible bucket. The bucket must be private: bytes leave only through Registry's own checks. */
export class S3RegistryArchiveStore implements RegistryArchiveStore {
  private readonly client: Bun.S3Client;
  constructor(config: RegistryArchiveStoreConfig) { this.client = new Bun.S3Client({ endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }); }
  async put(key: string, bytes: Uint8Array): Promise<void> { await this.client.write(key, bytes, { type: 'application/zstd' }); }
  async get(key: string): Promise<Uint8Array | null> { const file = this.client.file(key); if (!await file.exists()) return null; return new Uint8Array(await file.arrayBuffer()); }
  async delete(key: string): Promise<void> { await this.client.delete(key); }
}
