// S3/R2 upload, over Bun's native S3 client.
//
// This used to log what it would upload and return a URL nobody had checked
// existed — "For now, log what would be uploaded (Bun S3 API would be used
// in production)". Bun.S3Client is S3-compatible, so MinIO (self-hosted,
// Carbon Cloud's v1 target) and real S3/R2 are a config change, not a code
// change; this is the same client products/carbon-cloud's persistence layer
// uses for everything else.

import { statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Logger } from "@carbon/logging";

export interface S3Config {
  type: "s3" | "r2";
  bucket: string;
  prefix: string;
  region?: string;
  endpoint?: string; // For R2, or a self-hosted MinIO endpoint.
  accessKeyId?: string; // Env: AWS_ACCESS_KEY_ID or R2_ACCESS_KEY_ID
  secretAccessKey?: string; // Env: AWS_SECRET_ACCESS_KEY or R2_SECRET_ACCESS_KEY
}

export interface UploadResult {
  success: boolean;
  url: string;
  error?: string;
}

function client(config: S3Config): Bun.S3Client {
  const accessKeyId =
    process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || config.accessKeyId || "";
  const secretAccessKey =
    process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || config.secretAccessKey || "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("AWS/R2 credentials not found in environment or config");
  }
  return new Bun.S3Client({
    accessKeyId,
    secretAccessKey,
    bucket: config.bucket,
    region: config.region,
    endpoint: config.endpoint,
  });
}

function publicUrl(config: S3Config, key: string): string {
  if (config.type === "r2" && config.endpoint) {
    // R2's S3-compatible endpoint host starts with the account id.
    const accountId = new URL(config.endpoint).hostname.split(".")[0];
    return `https://${accountId}.cdn.cloudflare-r2.com/${key}`;
  }
  if (config.endpoint) {
    // Self-hosted (MinIO): the endpoint IS the public host, bucket-prefixed.
    return `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${key}`;
  }
  return `https://${config.bucket}.s3.${config.region || "us-east-1"}.amazonaws.com/${key}`;
}

/** Uploads one file, returning its public URL. */
export async function uploadToS3(
  config: S3Config,
  localPath: string,
  remotePath: string,
  logger?: Logger,
): Promise<UploadResult> {
  if (!existsSync(localPath)) {
    return { success: false, url: "", error: `File not found: ${localPath}` };
  }

  const key = `${config.prefix}${remotePath}`.replace(/^\/+/, "");
  try {
    const bytes = statSync(localPath).size;
    logger?.step(`uploading ${basename(localPath)} (${formatBytes(bytes)}) -> ${key}`);
    await client(config).write(key, Bun.file(localPath));
    const url = publicUrl(config, key);
    logger?.success(`uploaded ${url}`);
    return { success: true, url };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error(`upload failed: ${message}`);
    return { success: false, url: "", error: message };
  }
}

/** Uploads a manifest and its detached signature to `<channel>/manifest.json` + `.sig`. */
export async function uploadManifest(
  config: S3Config,
  manifestPath: string,
  sigPath: string,
  channel: string,
  logger?: Logger,
): Promise<{ manifest: UploadResult; signature: UploadResult }> {
  const [manifest, signature] = await Promise.all([
    uploadToS3(config, manifestPath, `${channel}/manifest.json`, logger),
    uploadToS3(config, sigPath, `${channel}/manifest.sig`, logger),
  ]);
  return { manifest, signature };
}

/** Uploads every built installer for a version, keyed by target-triple-shaped name. */
export async function uploadInstallers(
  config: S3Config,
  installerDir: string,
  version: string,
  platforms: string[],
  logger?: Logger,
): Promise<Record<string, UploadResult>> {
  const results: Record<string, UploadResult> = {};
  for (const platform of platforms) {
    const installerPath = join(installerDir, `app-${version}-${platform}`);
    if (!existsSync(installerPath)) {
      logger?.warn(`installer not found for ${platform}: ${installerPath}`);
      continue;
    }
    const remotePath = `releases/${version}/${basename(installerPath)}`;
    results[platform] = await uploadToS3(config, installerPath, remotePath, logger);
  }
  return results;
}

/** Every version that has at least one object under `releases/<version>/` for the given channel. */
export async function listReleases(config: S3Config, channel: string): Promise<string[]> {
  const prefix = `${config.prefix}releases/`.replace(/^\/+/, "");
  const { contents = [] } = await client(config).list({ prefix });
  const versions = new Set<string>();
  for (const entry of contents) {
    const rest = (entry.key ?? "").slice(prefix.length);
    const version = rest.split("/")[0];
    if (version) versions.add(version);
  }
  void channel; // channel-scoped releases live under a different prefix once channels exist per-org.
  return [...versions].sort();
}

/** Deletes a release's artifacts (one platform, or every platform for that version). */
export async function deleteRelease(
  config: S3Config,
  version: string,
  platform?: string,
): Promise<boolean> {
  const prefix = platform
    ? `${config.prefix}releases/${version}/app-${version}-${platform}`
    : `${config.prefix}releases/${version}/`;
  const s3 = client(config);
  const { contents = [] } = await s3.list({ prefix });
  for (const entry of contents) {
    if (entry.key) await s3.delete(entry.key);
  }
  return true;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}
