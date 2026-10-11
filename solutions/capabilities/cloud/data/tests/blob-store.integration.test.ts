// S3BlobStore against a real S3-compatible store. Runs only when a test store
// is configured (the same variables as the other object-store tests):
//
//   CARBON_OBJECT_STORE_TEST_ENDPOINT   e.g. http://127.0.0.1:55441 (MinIO)
//   CARBON_OBJECT_STORE_TEST_BUCKET     an existing, disposable bucket
//   CARBON_OBJECT_STORE_TEST_ACCESS_KEY_ID / CARBON_OBJECT_STORE_TEST_SECRET_ACCESS_KEY

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { S3BlobStore } from '../index.ts';

const endpoint = process.env.CARBON_OBJECT_STORE_TEST_ENDPOINT;
const config = { endpoint: endpoint ?? '', bucket: process.env.CARBON_OBJECT_STORE_TEST_BUCKET ?? '', accessKeyId: process.env.CARBON_OBJECT_STORE_TEST_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.CARBON_OBJECT_STORE_TEST_SECRET_ACCESS_KEY ?? '' };

describe.skipIf(!endpoint)('blob storage bytes', () => {
  test('every byte value is stored and read back unchanged, and a deleted object is gone', async () => {
    const store = new S3BlobStore(config); const key = `blobs/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    expect(await store.get(key)).toBeNull();
    const bytes = new Uint8Array(200_000); for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) % 256;
    await store.put(key, bytes, 'application/octet-stream');
    expect(Buffer.from((await store.get(key))!).equals(Buffer.from(bytes))).toBe(true);
    await store.delete(key); expect(await store.get(key)).toBeNull();
    // Cleanup may delete the same object twice.
    await store.delete(key);
    // Storage that cannot be reached is an error, never an empty result.
    expect(await new S3BlobStore({ ...config, secretAccessKey: 'wrong-secret' }).get(key).then(() => 'answered', () => 'refused')).toBe('refused');
  });
});
