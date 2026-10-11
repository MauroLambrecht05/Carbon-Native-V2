// S3ExportStore against a real S3-compatible store. Runs only when a test
// store is configured (the same variables as the artifact store test):
//
//   CARBON_OBJECT_STORE_TEST_ENDPOINT   e.g. http://127.0.0.1:55441 (MinIO)
//   CARBON_OBJECT_STORE_TEST_BUCKET     an existing, disposable bucket
//   CARBON_OBJECT_STORE_TEST_ACCESS_KEY_ID / CARBON_OBJECT_STORE_TEST_SECRET_ACCESS_KEY

import { describe, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { S3ExportStore } from '../index.ts';

const endpoint = process.env.CARBON_OBJECT_STORE_TEST_ENDPOINT;
const config = { endpoint: endpoint ?? '', bucket: process.env.CARBON_OBJECT_STORE_TEST_BUCKET ?? '', accessKeyId: process.env.CARBON_OBJECT_STORE_TEST_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.CARBON_OBJECT_STORE_TEST_SECRET_ACCESS_KEY ?? '' };

describe.skipIf(!endpoint)('export storage', () => {
  test('parts are written, overwritten in place, read back exactly and deleted', async () => {
    const store = new S3ExportStore(config); const key = `exports/${randomUUID()}/${randomUUID()}/${randomUUID()}/000001`;
    expect(await store.get(key)).toBeNull();
    const first = randomBytes(700_000); await store.put(key, first);
    expect(Buffer.from((await store.get(key))!).equals(first)).toBe(true);
    // A resumed job writes the same part again under the same key.
    const second = randomBytes(300_000); await store.put(key, second);
    expect(Buffer.from((await store.get(key))!).equals(second)).toBe(true);
    await store.delete(key); expect(await store.get(key)).toBeNull();
    // Deleting what is already gone is not an error: the sweep may run twice.
    await store.delete(key);
    // Storage that cannot be reached is an error, never an empty result.
    const failure = await new S3ExportStore({ ...config, secretAccessKey: 'wrong-secret' }).get(key).then(() => 'answered', () => 'refused');
    expect(failure).toBe('refused');
  });
});
