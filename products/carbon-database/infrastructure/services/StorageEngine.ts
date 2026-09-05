// Real object storage: file BYTES go to an S3-compatible bucket (MinIO in
// dev, via Bun's own S3Client — same client, same env-var names
// OBJECT_STORE_ENDPOINT/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET carbon-
// cloud's worker already uses, for consistency across products). Bucket/
// file METADATA lives in Postgres (storage_buckets/storage_files) so
// listing doesn't need a round trip to S3's own list API.
//
// KEY LAYOUT: `${projectId}/${bucketName}/${path}` inside the ONE shared
// S3 bucket this product owns — carbon-database's own buckets are a
// Carbon-level concept (per-project, app-developer-created), not real S3
// buckets each; giving every app-developer bucket a real S3 bucket would
// need dynamic bucket provisioning, a materially larger piece of work not
// needed for a v1 built on a single shared bucket with key-prefix
// isolation instead.

import { assertValidIdentifier } from "../persistence/identifiers.ts";

export interface StoredFileMeta {
  readonly path: string;
  readonly size: number;
  readonly contentType: string;
  readonly createdAt: Date;
}

export interface StorageBucketMeta {
  readonly name: string;
  readonly isPublic: boolean;
  readonly createdAt: Date;
}

export class StorageEngine {
  constructor(
    private readonly sql: Bun.SQL,
    private readonly s3: Bun.S3Client,
  ) {}

  private objectKey(projectId: string, bucketName: string, filePath: string): string {
    const normalized = filePath.replace(/^\/+/, "");
    return `${projectId}/${bucketName}/${normalized}`;
  }

  async createBucket(projectId: string, bucketName: string, isPublic = true): Promise<StorageBucketMeta> {
    assertValidIdentifier(bucketName, "bucket name");
    const existing = await this.getBucket(projectId, bucketName);
    if (existing) throw new Error(`Bucket "${bucketName}" already exists in project "${projectId}"`);
    const createdAt = new Date();
    await this.sql`
      INSERT INTO storage_buckets (project_id, name, is_public, created_at) VALUES (${projectId}, ${bucketName}, ${isPublic}, ${createdAt})
    `;
    return { name: bucketName, isPublic, createdAt };
  }

  async getBucket(projectId: string, bucketName: string): Promise<StorageBucketMeta | undefined> {
    const rows = await this.sql<Array<{ is_public: boolean; created_at: Date }>>`
      SELECT is_public, created_at FROM storage_buckets WHERE project_id = ${projectId} AND name = ${bucketName}
    `;
    const row = rows[0];
    if (!row) return undefined;
    return { name: bucketName, isPublic: row.is_public, createdAt: new Date(row.created_at) };
  }

  async listBuckets(
    projectId: string,
  ): Promise<{ name: string; isPublic: boolean; fileCount: number; createdAt: Date }[]> {
    const rows = await this.sql<Array<{ name: string; is_public: boolean; created_at: Date }>>`
      SELECT name, is_public, created_at FROM storage_buckets WHERE project_id = ${projectId} ORDER BY name
    `;
    const out: { name: string; isPublic: boolean; fileCount: number; createdAt: Date }[] = [];
    for (const r of rows) {
      const countRows = await this.sql<Array<{ count: string }>>`
        SELECT COUNT(*)::text AS count FROM storage_files WHERE project_id = ${projectId} AND bucket = ${r.name}
      `;
      out.push({
        name: r.name,
        isPublic: r.is_public,
        fileCount: Number(countRows[0]?.count ?? 0),
        createdAt: new Date(r.created_at),
      });
    }
    return out;
  }

  async deleteBucket(projectId: string, bucketName: string): Promise<boolean> {
    const files = await this.listFiles(projectId, bucketName);
    for (const f of files) await this.deleteFile(projectId, bucketName, f.path);
    const result = await this.sql`DELETE FROM storage_buckets WHERE project_id = ${projectId} AND name = ${bucketName}`;
    return true;
  }

  async uploadFile(
    projectId: string,
    bucketName: string,
    filePath: string,
    content: Uint8Array | string,
    contentType = "application/octet-stream",
  ): Promise<StoredFileMeta> {
    const bucket = await this.getBucket(projectId, bucketName);
    if (!bucket) throw new Error(`Bucket "${bucketName}" not found in project "${projectId}"`);

    const normalizedPath = filePath.replace(/^\/+/, "");
    const size = typeof content === "string" ? new TextEncoder().encode(content).length : content.byteLength;
    const key = this.objectKey(projectId, bucketName, normalizedPath);

    await this.s3.write(key, content, { type: contentType });

    const createdAt = new Date();
    await this.sql`
      INSERT INTO storage_files (project_id, bucket, path, size_bytes, content_type, created_at)
      VALUES (${projectId}, ${bucketName}, ${normalizedPath}, ${size}, ${contentType}, ${createdAt})
      ON CONFLICT (project_id, bucket, path)
      DO UPDATE SET size_bytes = EXCLUDED.size_bytes, content_type = EXCLUDED.content_type, created_at = EXCLUDED.created_at
    `;

    return { path: normalizedPath, size, contentType, createdAt };
  }

  /** Reads the real object bytes back from S3, or undefined if not found. */
  async getFile(
    projectId: string,
    bucketName: string,
    filePath: string,
  ): Promise<{ content: ArrayBuffer; contentType: string; size: number } | undefined> {
    const normalizedPath = filePath.replace(/^\/+/, "");
    const rows = await this.sql<Array<{ content_type: string; size_bytes: number }>>`
      SELECT content_type, size_bytes FROM storage_files WHERE project_id = ${projectId} AND bucket = ${bucketName} AND path = ${normalizedPath}
    `;
    const row = rows[0];
    if (!row) return undefined;
    const key = this.objectKey(projectId, bucketName, normalizedPath);
    const file = this.s3.file(key);
    if (!(await file.exists())) return undefined;
    const content = await file.arrayBuffer();
    return { content, contentType: row.content_type, size: row.size_bytes };
  }

  async listFiles(projectId: string, bucketName: string): Promise<StoredFileMeta[]> {
    const rows = await this.sql<Array<{ path: string; size_bytes: number; content_type: string; created_at: Date }>>`
      SELECT path, size_bytes, content_type, created_at FROM storage_files WHERE project_id = ${projectId} AND bucket = ${bucketName} ORDER BY path
    `;
    return rows.map((r) => ({
      path: r.path,
      size: r.size_bytes,
      contentType: r.content_type,
      createdAt: new Date(r.created_at),
    }));
  }

  async deleteFile(projectId: string, bucketName: string, filePath: string): Promise<boolean> {
    const normalizedPath = filePath.replace(/^\/+/, "");
    const key = this.objectKey(projectId, bucketName, normalizedPath);
    await this.s3.file(key).delete().catch(() => {});
    const result = await this.sql`
      DELETE FROM storage_files WHERE project_id = ${projectId} AND bucket = ${bucketName} AND path = ${normalizedPath} RETURNING path
    `;
    return result.length > 0;
  }

  getPublicUrl(projectId: string, bucketName: string, filePath: string): string {
    const normalized = filePath.replace(/^\/+/, "");
    return `/storage/v1/object/public/${projectId}/${bucketName}/${normalized}`;
  }
}
