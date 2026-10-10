import { describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AwsKmsSecretKeyCustodian, signAwsRequest } from '../infrastructure/AwsKmsSecretKeyCustodian.ts';
import { EnvelopeSecretProtector } from '../infrastructure/EnvelopeSecretProtector.ts';

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const OLD = 'arn:aws:kms:eu-west-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const NEW = 'arn:aws:kms:eu-west-1:111122223333:key/0987dcba-09fe-87dc-65ba-ab0987654321';

/** Stands in for KMS: one AES key per KMS key, with the encryption context bound as associated data. */
function fakeKms() {
  const roots = new Map<string, Buffer>(); const calls: { action: string; payload: Record<string, any>; headers: Headers }[] = [];
  let failure: Response | undefined;
  const root = (id: string) => { if (!roots.has(id)) roots.set(id, randomBytes(32)); return roots.get(id)!; };
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers); const payload = JSON.parse(String(init?.body)); const action = headers.get('x-amz-target')!.split('.')[1]!;
    expect(String(input)).toBe('https://kms.eu-west-1.amazonaws.com/'); expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    expect(headers.get('content-type')).toBe('application/x-amz-json-1.1');
    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/kms\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[a-f0-9]{64}$/);
    calls.push({ action, payload, headers });
    if (failure) return failure;
    const aad = Buffer.from(JSON.stringify(payload.EncryptionContext));
    if (action === 'Encrypt') {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', root(payload.KeyId), iv); cipher.setAAD(aad);
      const sealed = Buffer.concat([cipher.update(Buffer.from(payload.Plaintext, 'base64')), cipher.final()]);
      return Response.json({ KeyId: payload.KeyId, CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64') });
    }
    try {
      const data = Buffer.from(payload.CiphertextBlob, 'base64'); const decipher = createDecipheriv('aes-256-gcm', root(payload.KeyId), data.subarray(0, 12));
      decipher.setAAD(aad); decipher.setAuthTag(data.subarray(12, 28));
      return Response.json({ KeyId: payload.KeyId, Plaintext: Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('base64') });
    } catch { return Response.json({ __type: 'InvalidCiphertextException', message: 'provider detail that must not leak' }, { status: 400 }); }
  }) as typeof fetch;
  return { transport, calls, fail: (response?: Response) => { failure = response; } };
}

describe('AWS KMS secret custody', () => {
  test('signs requests with AWS Signature Version 4 (published AWS example)', () => {
    const headers = signAwsRequest({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: '' }, 'us-east-1', 'iam', credentials, new Date('2015-08-30T12:36:00Z'));
    expect(headers['x-amz-date']).toBe('20150830T123600Z'); expect(headers.host).toBe('iam.amazonaws.com');
    expect(headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    const session = signAwsRequest({ method: 'POST', url: 'https://kms.eu-west-1.amazonaws.com/', headers: {}, body: '{}' }, 'eu-west-1', 'kms', { ...credentials, sessionToken: 'session' }, new Date('2026-10-10T00:00:00Z'));
    expect(session['x-amz-security-token']).toBe('session'); expect(session.authorization).toContain('SignedHeaders=host;x-amz-date;x-amz-security-token');
  });

  test('wraps and unwraps data keys in KMS, bound to the secret context and the named key', async () => {
    const kms = fakeKms(); const custodian = new AwsKmsSecretKeyCustodian('eu-west-1', 'k1', { k1: OLD }, credentials, kms.transport);
    const dataKey = randomBytes(32); const wrapped = await custodian.wrap(dataKey, 'environment-secret:a:version:1');
    expect(wrapped.keyId).toBe('k1'); expect(wrapped.ciphertext).not.toContain(dataKey.toString('base64'));
    expect(kms.calls[0]).toMatchObject({ action: 'Encrypt', payload: { KeyId: OLD, EncryptionContext: { 'carbon-secret': 'environment-secret:a:version:1' } } });
    expect(Buffer.from(await custodian.unwrap(wrapped, 'environment-secret:a:version:1')).equals(dataKey)).toBe(true);
    expect(kms.calls[1]).toMatchObject({ action: 'Decrypt', payload: { KeyId: OLD, CiphertextBlob: wrapped.ciphertext } });
    // Another secret's context, an unknown key ID and a tampered ciphertext are all refused without provider detail.
    for (const attempt of [custodian.unwrap(wrapped, 'environment-secret:b:version:1'), custodian.unwrap({ ...wrapped, keyId: 'missing' }, 'environment-secret:a:version:1'),
      custodian.unwrap({ ...wrapped, ciphertext: Buffer.from(randomBytes(60)).toString('base64') }, 'environment-secret:a:version:1')]) {
      const error = await attempt.then(() => undefined, failure => failure as Error);
      expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('provider detail');
    }
  });

  test('envelopes survive wrapping-key rotation and fail closed when KMS refuses or is unreachable', async () => {
    const kms = fakeKms(); const before = new EnvelopeSecretProtector(new AwsKmsSecretKeyCustodian('eu-west-1', 'k1', { k1: OLD }, credentials, kms.transport));
    const first = await before.seal('first secret value', 'environment-secret:a:version:1');
    expect(first.wrappingKeyId).toBe('k1'); expect(first.envelope).not.toContain('first secret value');
    const after = new EnvelopeSecretProtector(new AwsKmsSecretKeyCustodian('eu-west-1', 'k2', { k1: OLD, k2: NEW }, credentials, kms.transport));
    expect(await after.open(first, 'environment-secret:a:version:1')).toBe('first secret value');
    const second = await after.seal('second secret value', 'environment-secret:a:version:2');
    expect(second.wrappingKeyId).toBe('k2'); expect(kms.calls.at(-1)!.payload.KeyId).toBe(NEW);
    expect(await after.open(second, 'environment-secret:a:version:2')).toBe('second secret value');
    const retired = new EnvelopeSecretProtector(new AwsKmsSecretKeyCustodian('eu-west-1', 'k2', { k2: NEW }, credentials, kms.transport));
    await expect(retired.open(first, 'environment-secret:a:version:1')).rejects.toThrow('Cannot decrypt environment secret');
    kms.fail(Response.json({ __type: 'AccessDeniedException', message: 'arn:aws:iam::111122223333:role/secret-detail' }, { status: 400 }));
    const denied = await after.seal('value', 'environment-secret:a:version:3').then(() => undefined, failure => failure as Error);
    expect(String(denied)).toContain('AWS KMS Encrypt was refused'); expect(String(denied)).not.toContain('secret-detail');
    await expect(after.open(second, 'environment-secret:a:version:2')).rejects.toThrow('Cannot decrypt environment secret');
    const offline = new AwsKmsSecretKeyCustodian('eu-west-1', 'k1', { k1: OLD }, credentials, (async () => { throw new Error('socket detail'); }) as unknown as typeof fetch);
    await expect(offline.wrap(randomBytes(32), 'context')).rejects.toThrow('AWS KMS could not be reached');
  });

  test('configuration rejects malformed regions, keys and missing credentials', () => {
    const make = (region: string, active: string, keys: Record<string, string>, creds = credentials) => () => new AwsKmsSecretKeyCustodian(region, active, keys, creds);
    expect(make('eu-west-1', 'k1', { k1: OLD })).not.toThrow();
    expect(make('eu-west-1', 'k1', { k1: 'alias/carbon-secrets' })).not.toThrow();
    expect(make('not a region', 'k1', { k1: OLD })).toThrow('Invalid AWS KMS region');
    expect(make('eu-west-1', 'k1', { k1: 'https://attacker.test/key' })).toThrow('Invalid AWS KMS key configuration');
    expect(make('eu-west-1', 'k2', { k1: OLD })).toThrow('Active secret wrapping key is missing');
    expect(make('eu-west-1', 'k1', { k1: OLD }, { accessKeyId: '', secretAccessKey: '' })).toThrow('AWS KMS credentials are required');
  });
});
