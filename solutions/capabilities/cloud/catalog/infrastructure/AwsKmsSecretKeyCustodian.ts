import { createHash, createHmac } from 'node:crypto';
import type { SecretKeyCustodian, WrappedSecretKey } from '../application/ports/SecretProtection.ts';

export interface AwsCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
export interface AwsSignedRequest { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: string }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();

/** AWS Signature Version 4 for a request whose headers are all signed. Returns the headers to send. */
export function signAwsRequest(request: AwsSignedRequest, region: string, service: string, credentials: AwsCredentials, now: Date): Record<string, string> {
  const url = new URL(request.url); const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ''); const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...request.headers, host: url.host, 'x-amz-date': amzDate, ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}) };
  const names = Object.keys(headers).map(name => name.toLowerCase()).sort();
  const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')]));
  const query = [...url.searchParams].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).sort().join('&');
  const canonical = [request.method, url.pathname || '/', query, ...names.map(name => `${name}:${lowered[name]}`), '', names.join(';'), sha256(request.body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/**
 * Hosted wrapping-key custody in AWS KMS. Data keys are wrapped and unwrapped by KMS Encrypt/Decrypt; the wrapping
 * key never leaves KMS. Carbon key IDs map to KMS keys so an old envelope stays readable after the active key changes.
 * The secret's identity is bound as KMS encryption context, so a wrapped key cannot be unwrapped for another secret.
 */
export class AwsKmsSecretKeyCustodian implements SecretKeyCustodian {
  private readonly keys: ReadonlyMap<string, string>;
  constructor(private readonly region: string, private readonly activeKeyId: string, keys: Readonly<Record<string, string>>, private readonly credentials: AwsCredentials,
    private readonly transport: typeof fetch = fetch, private readonly now: () => Date = () => new Date()) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error('Invalid AWS KMS region');
    if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('AWS KMS credentials are required');
    this.keys = new Map(Object.entries(keys).map(([id, key]) => {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof key !== 'string' || !/^(arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:(key|alias)\/[A-Za-z0-9/_-]+|[0-9a-f-]{36}|alias\/[A-Za-z0-9/_-]+)$/.test(key)) throw new Error('Invalid AWS KMS key configuration');
      return [id, key];
    }));
    if (!this.keys.has(activeKeyId)) throw new Error('Active secret wrapping key is missing');
  }

  private async call(action: 'Encrypt' | 'Decrypt', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const body = JSON.stringify(payload); const url = `https://kms.${this.region}.amazonaws.com/`;
    const headers = signAwsRequest({ method: 'POST', url, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${action}` }, body }, this.region, 'kms', this.credentials, this.now());
    let response: Response;
    try { response = await this.transport(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { throw new Error('AWS KMS could not be reached'); }
    // Provider error bodies can echo request data; never surface them.
    if (response.status !== 200) { await response.body?.cancel(); throw new Error(`AWS KMS ${action} was refused`); }
    return await response.json() as Record<string, unknown>;
  }

  async wrap(dataKey: Uint8Array, context: string): Promise<WrappedSecretKey> {
    const result = await this.call('Encrypt', { KeyId: this.keys.get(this.activeKeyId)!, Plaintext: Buffer.from(dataKey).toString('base64'), EncryptionContext: { 'carbon-secret': context } });
    if (typeof result.CiphertextBlob !== 'string' || !result.CiphertextBlob) throw new Error('AWS KMS returned an invalid response');
    return { keyId: this.activeKeyId, ciphertext: result.CiphertextBlob };
  }

  async unwrap(key: WrappedSecretKey, context: string): Promise<Uint8Array> {
    const kmsKey = this.keys.get(key.keyId);
    if (!kmsKey) throw new Error('Unknown secret wrapping key');
    // Naming the key makes KMS refuse a ciphertext produced under any other key.
    const result = await this.call('Decrypt', { KeyId: kmsKey, CiphertextBlob: key.ciphertext, EncryptionContext: { 'carbon-secret': context } });
    const plaintext = typeof result.Plaintext === 'string' ? Buffer.from(result.Plaintext, 'base64') : undefined;
    if (!plaintext || plaintext.length !== 32) throw new Error('AWS KMS returned an invalid response');
    return plaintext;
  }
}
