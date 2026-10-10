// The two ends of artifact storage against a real S3-compatible store: the
// worker uploads a file, and Cloud's verifier reads the stored bytes back.
// Runs only when a test store is configured:
//
//   CARBON_OBJECT_STORE_TEST_ENDPOINT   e.g. http://127.0.0.1:55441 (MinIO)
//   CARBON_OBJECT_STORE_TEST_BUCKET     an existing, disposable bucket
//   CARBON_OBJECT_STORE_TEST_ACCESS_KEY_ID / CARBON_OBJECT_STORE_TEST_SECRET_ACCESS_KEY

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3ArtifactVerifier } from "@carbon/orchestration";
import { S3ArtifactUploader } from "../index.ts";

const endpoint = process.env.CARBON_OBJECT_STORE_TEST_ENDPOINT;
const store = { endpoint: endpoint ?? "", bucket: process.env.CARBON_OBJECT_STORE_TEST_BUCKET ?? "", accessKeyId: process.env.CARBON_OBJECT_STORE_TEST_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.CARBON_OBJECT_STORE_TEST_SECRET_ACCESS_KEY ?? "" };

describe.skipIf(!endpoint)("artifact storage", () => {
  test("Cloud accepts exactly the bytes a worker uploaded, and nothing else", async () => {
    const directory = mkdtempSync(join(tmpdir(), "carbon-artifact-store-"));
    try {
      const uploader = new S3ArtifactUploader({ type: "s3", prefix: "", ...store }); const verifier = new S3ArtifactVerifier(store);
      // Larger than one read, so the digest is taken across chunks.
      const bytes = randomBytes(3 * 1024 * 1024 + 17); const path = join(directory, "setup.exe"); writeFileSync(path, bytes);
      const artifact = { objectKey: `artifacts/${randomUUID()}/1/nsis/setup.exe`, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
      expect(await verifier.verify(artifact)).toBe(false);
      await uploader.upload(path, artifact.objectKey);
      expect(await verifier.verify(artifact)).toBe(true);
      expect(await verifier.verify({ ...artifact, sha256: createHash("sha256").update("other").digest("hex") })).toBe(false);
      expect(await verifier.verify({ ...artifact, sizeBytes: artifact.sizeBytes - 1 })).toBe(false);
      expect(await verifier.verify({ ...artifact, objectKey: artifact.objectKey.replace("/1/", "/2/") })).toBe(false);
      // The object is replaced by one of the same size: the declared digest no longer matches what is stored.
      const swapped = Buffer.from(bytes); swapped[swapped.byteLength - 1]! ^= 1; writeFileSync(path, swapped); await uploader.upload(path, artifact.objectKey);
      expect(await verifier.verify(artifact)).toBe(false);
      // Storage that cannot be read is an error, never a verdict.
      await expect(new S3ArtifactVerifier({ ...store, secretAccessKey: "wrong-secret" }).verify(artifact)).rejects.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
