import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { PlatformFault, type EnvironmentScope } from '@carbon/contracts/platform';
import type { ArtifactReader, ReleaseSigner } from '../application/ports/PlatformReleaseRepository.ts';
import type { ArtifactStoreConfig } from './S3ArtifactVerifier.ts';

/** Reads one environment secret's current value. Implemented by the secret store; the value never leaves this process. */
export interface SigningSecretReader { read(scope: EnvironmentScope, name: string): Promise<string> }

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Signs update manifests and artifacts with an Ed25519 key kept as an environment secret. The secret is either the
 * 32-byte seed in base64 or a PKCS#8 PEM. It is decrypted for one signature and then dropped; signatures and public
 * keys are standard base64, the form every updater expects.
 */
export class SecretReleaseSigner implements ReleaseSigner {
  constructor(private readonly secrets: SigningSecretReader) {}

  private async key(scope: EnvironmentScope, secretName: string): Promise<KeyObject> {
    let value: string;
    try { value = (await this.secrets.read(scope, secretName)).trim(); } catch (error) {
      if (error instanceof PlatformFault && error.code === 'conflict') throw new PlatformFault('conflict', 'The signing secret is missing or disabled');
      throw error;
    }
    let key: KeyObject | undefined;
    try {
      if (value.includes('BEGIN PRIVATE KEY')) key = createPrivateKey(value);
      else { const seed = Buffer.from(value, 'base64'); if (seed.length === 32 && seed.toString('base64') === value) key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' }); }
    } catch { key = undefined; }
    // Never say what the value looked like.
    if (!key || key.asymmetricKeyType !== 'ed25519') throw new PlatformFault('validation', 'The signing secret is not an Ed25519 private key');
    return key;
  }
  private static raw(key: KeyObject): string { return (createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('base64'); }

  async publicKey(scope: EnvironmentScope, secretName: string): Promise<string> { return SecretReleaseSigner.raw(await this.key(scope, secretName)); }
  async sign(scope: EnvironmentScope, secretName: string, bytes: Uint8Array) {
    const key = await this.key(scope, secretName);
    return { signature: sign(null, bytes, key).toString('base64'), publicKey: SecretReleaseSigner.raw(key) };
  }
}

/** Reads a stored artifact from S3-compatible storage so it can be signed. */
export class S3ArtifactReader implements ArtifactReader {
  private readonly client: Bun.S3Client;
  constructor(config: ArtifactStoreConfig) { this.client = new Bun.S3Client({ endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }); }

  async read(objectKey: string, maximumBytes: number): Promise<Uint8Array | null> {
    const file = this.client.file(objectKey);
    if (!await file.exists()) return null;
    // The size is checked before the read so an oversized object is never pulled into memory.
    if ((await file.stat()).size > maximumBytes) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bytes.byteLength > maximumBytes ? null : bytes;
  }
}
