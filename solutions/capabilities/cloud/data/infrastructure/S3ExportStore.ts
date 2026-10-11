import type { ExportStore } from '../application/ports/ExportJobs.ts';

export interface ExportStoreConfig { readonly endpoint: string; readonly bucket: string; readonly accessKeyId: string; readonly secretAccessKey: string }

/**
 * Export parts in an S3-compatible bucket. The bucket must be private: nothing here ever produces a public or
 * presigned address, and downloads are served by Cloud after its own checks.
 */
export class S3ExportStore implements ExportStore {
  private readonly client: Bun.S3Client;
  constructor(config: ExportStoreConfig) { this.client = new Bun.S3Client({ endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }); }

  async put(objectKey: string, bytes: Uint8Array): Promise<void> { await this.client.write(objectKey, bytes); }
  async get(objectKey: string): Promise<Uint8Array | null> {
    const file = this.client.file(objectKey);
    if (!await file.exists()) return null;
    return new Uint8Array(await file.arrayBuffer());
  }
  async delete(objectKey: string): Promise<void> { await this.client.delete(objectKey); }
}
