// Who vouches for a published package, and how an installer checks it.
//
// Registry signs one statement per published version with an Ed25519 signing
// key. The statement names the package, version, target, archive digest and
// size, so a signature cannot be moved to another package or version.
//
// The signing keys themselves are listed in a trust bundle signed by a root
// key that Registry never holds. An installer pins the root public key, and
// nothing a Registry endpoint returns can change which keys it trusts.

import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalJson, parseComponent, type RegistryManifest, type RegistryPublicVersion, type RegistrySignedStatement, type RegistryStatement, type RegistryTrustBundle } from '@carbon/contracts/platform';
import type { PackageCoordinates } from './RegistryArchive.ts';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
// A signature over one kind of document can never be presented as the other.
const STATEMENT_DOMAIN = 'carbon-registry-statement-v1\n';
const BUNDLE_DOMAIN = 'carbon-registry-trust-bundle-v1\n';

/** Why a package or a trust bundle was not accepted. The category is stable; installers branch on it. */
export class RegistryTrustError extends Error { constructor(readonly category: string) { super(`Registry trust check failed: ${category}`); } }
const refuse = (category: string): never => { throw new RegistryTrustError(category); };

function privateKey(seedHex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('An Ed25519 seed is 64 lowercase hex characters');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
}
function publicKey(hex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/.test(hex)) refuse('key_invalid');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}
export function publicKeyHex(seedHex: string): string {
  return Buffer.from((createPublicKey(privateKey(seedHex)).export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('hex');
}
const signed = (domain: string, value: unknown, key: KeyObject) => sign(null, Buffer.from(domain + canonicalJson(value), 'utf8'), key).toString('base64');
function valid(domain: string, value: unknown, signature: string, key: KeyObject): boolean {
  try { return verify(null, Buffer.from(domain + canonicalJson(value), 'utf8'), key, Buffer.from(signature, 'base64')); } catch { return false; }
}

export const manifestDigest = (manifest: RegistryManifest) => createHash('sha256').update(canonicalJson(parseComponent('RegistryManifest', manifest)), 'utf8').digest('hex');

/** Signs a trust bundle with the root key. This runs where the root key is kept, never inside Registry. */
export function signTrustBundle(rootSeedHex: string, bundle: RegistryTrustBundle['bundle']): RegistryTrustBundle {
  return parseComponent('RegistryTrustBundle', { bundle, signature: signed(BUNDLE_DOMAIN, bundle, privateKey(rootSeedHex)) });
}

/**
 * Accepts a trust bundle only if the pinned root signed it and it is not older than one already seen. Returns the
 * bundle. `minimumSequence` is the highest sequence the caller has accepted before: an older bundle could bring a
 * revoked key back.
 */
export function verifyTrustBundle(rootPublicKeyHex: string, input: RegistryTrustBundle, minimumSequence = 0): RegistryTrustBundle['bundle'] {
  let trust: RegistryTrustBundle; try { trust = parseComponent('RegistryTrustBundle', input); } catch { return refuse('bundle_invalid'); }
  if (!valid(BUNDLE_DOMAIN, trust.bundle, trust.signature, publicKey(rootPublicKeyHex))) refuse('bundle_signature');
  if (new Set(trust.bundle.keys.map(key => key.id)).size !== trust.bundle.keys.length) refuse('bundle_invalid');
  if (trust.bundle.sequence < minimumSequence) refuse('bundle_rollback');
  return trust.bundle;
}

/** Registry's signing key. It can sign statements and nothing else. */
export class RegistrySigner {
  private readonly key: KeyObject; readonly publicKeyHex: string;
  constructor(readonly keyId: string, seedHex: string) { this.key = privateKey(seedHex); this.publicKeyHex = publicKeyHex(seedHex); }
  sign(statement: RegistryStatement): RegistrySignedStatement {
    const value = parseComponent('RegistryStatement', statement);
    return parseComponent('RegistrySignedStatement', { statement: value, keyId: this.keyId, signature: signed(STATEMENT_DOMAIN, value, this.key) });
  }
}

export interface RegistryTrust { readonly signer: RegistrySigner; readonly bundle: RegistryTrustBundle }
/**
 * Registry's trust material at start-up. It refuses to start publishing unless the root signed the bundle and the
 * bundle lists this exact signing key as active: there is no fallback to a generated key.
 */
export function openRegistryTrust(input: { readonly rootPublicKey: string; readonly bundle: RegistryTrustBundle; readonly keyId: string; readonly signingSeed: string }): RegistryTrust {
  const bundle = verifyTrustBundle(input.rootPublicKey, input.bundle); const signer = new RegistrySigner(input.keyId, input.signingSeed);
  const listed = bundle.keys.find(key => key.id === input.keyId);
  if (!listed || listed.state !== 'active' || listed.publicKey !== signer.publicKeyHex) throw new RegistryTrustError('signing_key_not_active');
  return { signer, bundle: input.bundle };
}

export interface PackageCheck {
  /** The root public key the installer was built or configured with. Never taken from Registry. */
  readonly rootPublicKey: string;
  readonly trust: RegistryTrustBundle;
  readonly minimumSequence?: number;
  /** What the installer asked for. */
  readonly expected: PackageCoordinates;
  readonly version: RegistryPublicVersion;
  readonly bytes: Uint8Array;
}
/**
 * Everything an installer checks before it trusts downloaded bytes: the bundle against the pinned root, the
 * statement's signature against a key the bundle has not revoked, that the statement is for exactly what was asked
 * for, and that the bytes are the ones the statement names. Throws a RegistryTrustError otherwise.
 */
export function verifyRegistryPackage(check: PackageCheck): RegistryStatement {
  const bundle = verifyTrustBundle(check.rootPublicKey, check.trust, check.minimumSequence);
  let version: RegistryPublicVersion; try { version = parseComponent('RegistryPublicVersion', check.version); } catch { return refuse('version_invalid'); }
  if (version.state !== 'published') refuse('revoked');
  const key = bundle.keys.find(item => item.id === version.signed.keyId); if (!key) refuse('key_unknown');
  // A retiring key no longer signs new versions, but what it signed stays good. A revoked key vouches for nothing.
  if (key!.state === 'revoked') refuse('key_revoked');
  const statement = version.signed.statement;
  if (!valid(STATEMENT_DOMAIN, statement, version.signed.signature, publicKey(key!.publicKey))) refuse('signature');
  for (const field of ['publisher', 'name', 'version', 'target'] as const) if (statement[field] !== check.expected[field]) refuse('wrong_package');
  if (version.version !== statement.version || version.target !== statement.target) refuse('wrong_package');
  if (manifestDigest(version.manifest) !== statement.manifestDigest) refuse('manifest');
  if (check.bytes.length !== statement.sizeBytes || createHash('sha256').update(check.bytes).digest('hex') !== statement.sha256) refuse('digest');
  return statement;
}
