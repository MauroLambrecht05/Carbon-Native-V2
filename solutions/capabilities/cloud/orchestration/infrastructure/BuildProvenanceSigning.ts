import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { BuildProvenance } from '@carbon/contracts/platform';
import type { ProvenanceSigner } from '../application/ports/PlatformBuildRepository.ts';

/** Signs provenance statements with an Ed25519 key held by Cloud. */
export class Ed25519ProvenanceSigner implements ProvenanceSigner {
  private readonly key: KeyObject;
  constructor(readonly keyId: string, privateKey: string | KeyObject) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) throw new Error('Invalid provenance key identifier');
    try { this.key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey; } catch { throw new Error('Invalid provenance signing key'); }
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('Invalid provenance signing key');
  }
  sign(statement: string): string { return sign(null, Buffer.from(statement, 'utf8'), this.key).toString('base64url'); }
  publicKey(): KeyObject { return createPublicKey(this.key); }
}

/**
 * Verifies a provenance record a consumer received: the digest must be the SHA-256 of the statement as Cloud
 * serialized it, and the signature must be this key's over those bytes. An unsigned record never verifies.
 */
export function verifyBuildProvenance(provenance: BuildProvenance, publicKey: KeyObject, keyId: string): boolean {
  const canonical = JSON.stringify(provenance.statement);
  if (createHash('sha256').update(canonical).digest('hex') !== provenance.statementDigest) return false;
  if (!provenance.signature || provenance.signature.keyId !== keyId) return false;
  try { return verify(null, Buffer.from(canonical, 'utf8'), publicKey, Buffer.from(provenance.signature.value, 'base64url')); } catch { return false; }
}
