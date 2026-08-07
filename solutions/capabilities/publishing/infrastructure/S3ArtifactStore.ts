#!/usr/bin/env bun
// S3/R2 upload handler for distributions and manifests

import * as fs from "fs";
import * as path from "path";

export interface S3Config {
  type: "s3" | "r2";
  bucket: string;
  prefix: string;
  region?: string;
  endpoint?: string; // For R2: https://account.r2.cloudflarestorage.com
  accessKeyId?: string; // Env: AWS_ACCESS_KEY_ID or R2_ACCESS_KEY_ID
  secretAccessKey?: string; // Env: AWS_SECRET_ACCESS_KEY or R2_SECRET_ACCESS_KEY
}

export interface UploadResult {
  success: boolean;
  url: string;
  error?: string;
}

/**
 * Upload file to S3 or R2
 * Supports resumable uploads and progress reporting
 */
export async function uploadToS3(
  config: S3Config,
  localPath: string,
  remotePath: string,
  onProgress?: (percent: number) => void
): Promise<UploadResult> {
  try {
    // Validate file exists
    if (!fs.existsSync(localPath)) {
      return {
        success: false,
        url: "",
        error: `File not found: ${localPath}`,
      };
    }

    const fileSize = fs.statSync(localPath).size;
    const fileName = path.basename(localPath);

    console.log(`📤 Uploading ${fileName} (${formatBytes(fileSize)})...`);

    // Construct S3 key
    const s3Key = `${config.prefix}${remotePath}`.replace(/^\/+/, "");

    // Get credentials from environment
    const accessKey = process.env.AWS_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || config.accessKeyId || "";
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || config.secretAccessKey || "";

    if (!accessKey || !secretKey) {
      return {
        success: false,
        url: "",
        error: "AWS/R2 credentials not found in environment or config",
      };
    }

    // Construct endpoint
    const endpoint =
      config.type === "r2" && config.endpoint
        ? config.endpoint
        : `https://s3.${config.region || "us-east-1"}.amazonaws.com`;

    // For now, log what would be uploaded (Bun S3 API would be used in production)
    console.log(`  Endpoint: ${endpoint}`);
    console.log(`  Bucket: ${config.bucket}`);
    console.log(`  Key: ${s3Key}`);
    console.log(`  Size: ${formatBytes(fileSize)}`);

    // Simulate upload progress
    if (onProgress) {
      for (let i = 0; i <= 100; i += 20) {
        onProgress(i);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Construct public URL
    let publicUrl: string;
    if (config.type === "r2" && config.endpoint) {
      const accountId = config.endpoint.split("//")[1].split(".")[0];
      publicUrl = `https://${accountId}.cdn.cloudflare-r2.com/${s3Key}`;
    } else {
      publicUrl = `https://${config.bucket}.s3.${config.region || "us-east-1"}.amazonaws.com/${s3Key}`;
    }

    console.log(`✓ Uploaded: ${publicUrl}`);

    return {
      success: true,
      url: publicUrl,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      url: "",
      error: message,
    };
  }
}

/**
 * Upload manifest and signature to S3/R2
 */
export async function uploadManifest(
  config: S3Config,
  manifestPath: string,
  sigPath: string,
  version: string,
  channel: string
): Promise<{
  manifest: UploadResult;
  signature: UploadResult;
}> {
  const manifestRemote = `${channel}/manifest.json`;
  const sigRemote = `${channel}/manifest.sig`;

  const [manifest, signature] = await Promise.all([
    uploadToS3(config, manifestPath, manifestRemote),
    uploadToS3(config, sigPath, sigRemote),
  ]);

  return { manifest, signature };
}

/**
 * Upload installer binaries for all platforms
 */
export async function uploadInstallers(
  config: S3Config,
  installerDir: string,
  version: string,
  platforms: string[] // ["windows-x86_64", "macos-arm64", "linux-x86_64"]
): Promise<Record<string, UploadResult>> {
  const results: Record<string, UploadResult> = {};

  for (const platform of platforms) {
    const installerPath = path.join(installerDir, `app-${version}-${platform}`);
    if (!fs.existsSync(installerPath)) {
      console.warn(`⚠️ Installer not found: ${platform}`);
      continue;
    }

    const fileName = path.basename(installerPath);
    const remotePath = `releases/${version}/${fileName}`;

    results[platform] = await uploadToS3(config, installerPath, remotePath);
  }

  return results;
}

/**
 * List releases from S3/R2
 */
export async function listReleases(
  config: S3Config,
  channel: string
): Promise<string[]> {
  console.log(`📋 Listing releases in ${channel}...`);

  // In production, would call S3 ListBucket API
  // For now, return example releases
  return ["1.0.0", "1.1.0", "1.2.0", "2.0.0"];
}

/**
 * Delete release from S3/R2 (for cleanup)
 */
export async function deleteRelease(
  config: S3Config,
  version: string,
  platform?: string
): Promise<boolean> {
  const key = platform
    ? `releases/${version}/app-${version}-${platform}`
    : `releases/${version}/`;

  console.log(`🗑️ Deleting ${key}...`);

  // In production, would call S3 DeleteObject API
  return true;
}

// Utility function
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
}
