import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ProtectedSecret, SecretKeyCustodian, SecretProtector, WrappedSecretKey } from '../application/ports/SecretProtection.ts';

function encrypt(key: Uint8Array, plaintext: Uint8Array, aad: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

function decrypt(key: Uint8Array, ciphertext: string, aad: string): Buffer {
  const data = Buffer.from(ciphertext, 'base64');
  if (data.length < 28 || data.toString('base64') !== ciphertext) throw new Error('Invalid secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}

/** Explicit self-hosted wrapping-key custody. Hosted deployments replace this
 * adapter with KMS/HSM calls through SecretKeyCustodian. */
export class LocalAesSecretKeyCustodian implements SecretKeyCustodian {
  private readonly keys: ReadonlyMap<string, Buffer>;
  constructor(private readonly activeKeyId: string, keys: Readonly<Record<string, string>>) {
    this.keys = new Map(Object.entries(keys).map(([id, encoded]) => {
      const key = Buffer.from(encoded, 'base64');
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || key.length !== 32 || key.toString('base64') !== encoded) throw new Error('Invalid secret wrapping key configuration');
      return [id, key];
    }));
    if (!this.keys.has(activeKeyId)) throw new Error('Active secret wrapping key is missing');
  }

  async wrap(dataKey: Uint8Array, context: string): Promise<WrappedSecretKey> {
    return { keyId: this.activeKeyId, ciphertext: encrypt(this.keys.get(this.activeKeyId)!, dataKey, `carbon-secret-key:v1:${this.activeKeyId}:${context}`) };
  }

  async unwrap(key: WrappedSecretKey, context: string): Promise<Uint8Array> {
    const root = this.keys.get(key.keyId);
    if (!root) throw new Error('Unknown secret wrapping key');
    return decrypt(root, key.ciphertext, `carbon-secret-key:v1:${key.keyId}:${context}`);
  }
}

export class EnvelopeSecretProtector implements SecretProtector {
  constructor(private readonly custodian: SecretKeyCustodian) {}

  async seal(plaintext: string, context: string): Promise<ProtectedSecret> {
    const bytes = Buffer.from(plaintext, 'utf8');
    if (bytes.length < 1 || bytes.length > 65536) throw new Error('Environment secret exceeds limit');
    const dataKey = randomBytes(32);
    try {
      const wrapped = await this.custodian.wrap(dataKey, context);
      const payload = encrypt(dataKey, bytes, `carbon-secret:v1:${context}`);
      return { wrappingKeyId: wrapped.keyId, envelope: JSON.stringify({ version: 1, wrappedKey: wrapped.ciphertext, payload }) };
    } finally { dataKey.fill(0); bytes.fill(0); }
  }

  async open(secret: ProtectedSecret, context: string): Promise<string> {
    let dataKey: Uint8Array | undefined;
    try {
      if (secret.envelope.length > 262144 || !/^[A-Za-z0-9_-]{1,80}$/.test(secret.wrappingKeyId)) throw new Error();
      const envelope = JSON.parse(secret.envelope);
      if (envelope.version !== 1 || typeof envelope.wrappedKey !== 'string' || typeof envelope.payload !== 'string') throw new Error();
      dataKey = await this.custodian.unwrap({ keyId: secret.wrappingKeyId, ciphertext: envelope.wrappedKey }, context);
      const plaintext = decrypt(dataKey, envelope.payload, `carbon-secret:v1:${context}`);
      try { return plaintext.toString('utf8'); } finally { plaintext.fill(0); }
    } catch { throw new Error('Cannot decrypt environment secret'); }
    finally { if (dataKey) Buffer.from(dataKey.buffer, dataKey.byteOffset, dataKey.byteLength).fill(0); }
  }
}
