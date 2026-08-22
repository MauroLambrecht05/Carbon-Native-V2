// The on-disk key and signature file formats.
//
// Ported from V1 tools/signer/src/minisign.rs. Byte-for-byte compatible with
// the Rust implementation: same field order, same little-endian widths, same
// Argon2id parameters, same XChaCha20-Poly1305 construction. Keys and
// signatures written by V1's crate load here and vice versa — which is the
// whole point of porting rather than redesigning, since keys already exist in
// the wild and a signature that stops verifying is a broken update channel.
//
// This is infrastructure, not domain: it is entirely about a byte layout on
// disk. Isolating it here is what lets the format stay frozen while the use
// cases above it change freely.
//
// Crypto comes from @noble/* (pure TypeScript, audited) rather than a native
// module, so the CLI has no build step and no per-platform binary.

import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argon2id } from "@noble/hashes/argon2";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import {
  SigningKey,
  VerifyingKey,
  deriveKeyId,
  KEY_BYTES,
  SIGNATURE_BYTES,
  KEY_ID_BYTES,
} from "../domain/value-objects/Keypair.ts";

/** "Ed" — Ed25519, matching minisign's algorithm tag. */
export const ALGORITHM = new Uint8Array([0x45, 0x64]);
/** "Ar" — Argon2id key derivation. */
export const KDF = new Uint8Array([0x41, 0x72]);
/** "PW" — the checksum tag V1 wrote. Read back but never validated, exactly
 *  as in the Rust (`let _cksum = ...`). Kept so the byte layout matches. */
export const CKSUM = new Uint8Array([0x50, 0x57]);

const KDF_SALT_BYTES = 32;
const NONCE_BYTES = 24;

/**
 * Argon2id cost parameters. These are not tunable: they are baked into the
 * secret-key file (opslimit/memlimit fields) and re-read on decrypt, so a key
 * written with one set still opens after these defaults change. The values
 * mirror `Params::new(65540, 3, 4, None)` in the Rust.
 */
export const DEFAULT_MEMLIMIT_KIB = 65540;
export const DEFAULT_OPSLIMIT = 3;
export const ARGON2_PARALLELISM = 4;

export interface SecretKeyFile {
  algorithm: Uint8Array;
  kdf: Uint8Array;
  cksum: Uint8Array;
  kdfSalt: Uint8Array;
  kdfOpslimit: bigint;
  kdfMemlimit: bigint;
  keyId: Uint8Array;
  encryptedKey: Uint8Array;
}

export interface PublicKeyFile {
  algorithm: Uint8Array;
  keyId: Uint8Array;
  publicKey: Uint8Array;
}

export interface SigFile {
  algorithm: Uint8Array;
  keyId: Uint8Array;
  globalSignature: Uint8Array;
  trustedComment: string;
  commentSignature: Uint8Array;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u64le(value: bigint): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return new Uint8Array(buf);
}

function deriveEncryptionKey(
  password: string,
  salt: Uint8Array,
  memlimitKib: number,
  opslimit: number,
): Uint8Array {
  return argon2id(new TextEncoder().encode(password), salt, {
    t: opslimit,
    m: memlimitKib,
    p: ARGON2_PARALLELISM,
    dkLen: 32,
  });
}

/** Writes `<name>.pub` and `<name>.key` into `outDir`; returns both paths. */
export function writeKeypair(
  sk: SigningKey,
  vk: VerifyingKey,
  name: string,
  password: string,
  outDir: string,
): { pubkeyPath: string; seckeyPath: string } {
  const kdfSalt = new Uint8Array(randomBytes(KDF_SALT_BYTES));
  const passwordHash = deriveEncryptionKey(
    password,
    kdfSalt,
    DEFAULT_MEMLIMIT_KIB,
    DEFAULT_OPSLIMIT,
  );

  const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
  const cipher = xchacha20poly1305(passwordHash, nonce);

  // The sealed plaintext is seed || public key, so decrypting recovers both
  // halves without a second derivation.
  const plaintext = concat(sk.toBytes(), vk.toBytes());
  const ciphertext = cipher.encrypt(plaintext);

  const secFile: SecretKeyFile = {
    algorithm: ALGORITHM,
    kdf: KDF,
    cksum: CKSUM,
    kdfSalt,
    kdfOpslimit: BigInt(DEFAULT_OPSLIMIT),
    kdfMemlimit: BigInt(DEFAULT_MEMLIMIT_KIB),
    keyId: sk.keyId,
    encryptedKey: concat(nonce, ciphertext),
  };

  const pubFile: PublicKeyFile = {
    algorithm: ALGORITHM,
    keyId: vk.keyId,
    publicKey: vk.toBytes(),
  };

  const pubkeyPath = join(outDir, `${name}.pub`);
  const seckeyPath = join(outDir, `${name}.key`);

  writePublicKey(pubFile, pubkeyPath);
  writeSecretKey(secFile, seckeyPath);

  return { pubkeyPath, seckeyPath };
}

export function writePublicKey(file: PublicKeyFile, path: string): void {
  const data = concat(file.algorithm, file.keyId, file.publicKey);
  const content = `untrusted comment: minisign public key\n${Buffer.from(data).toString("base64")}\n`;
  writeFileSync(path, content);
}

export function writeSecretKey(file: SecretKeyFile, path: string): void {
  const data = concat(
    file.algorithm,
    file.kdf,
    file.cksum,
    file.kdfSalt,
    u64le(file.kdfOpslimit),
    u64le(file.kdfMemlimit),
    file.keyId,
    file.encryptedKey,
  );
  const content = `untrusted comment: minisign secret key\n${Buffer.from(data).toString("base64")}\n`;
  writeFileSync(path, content);

  // The Rust guarded this with #[cfg(unix)]. chmod is a no-op on Windows
  // rather than an error, but the guard is kept so intent stays readable.
  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
  }
}

export function writeSigFile(file: SigFile, path: string): void {
  const data = concat(file.algorithm, file.keyId, file.globalSignature);
  let content = `untrusted comment: signature\n${Buffer.from(data).toString("base64")}\n`;

  if (file.trustedComment.length > 0) {
    content += `trusted comment: ${file.trustedComment}\n`;
    const sigData = concat(file.algorithm, file.keyId, file.commentSignature);
    content += `${Buffer.from(sigData).toString("base64")}\n`;
  }

  writeFileSync(path, content);
}

/** Second line of a key/signature file, base64-decoded. */
function decodeBody(path: string, what: string): Uint8Array {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  if (lines.length < 2) {
    throw new Error(`invalid ${what} file: ${path}`);
  }
  return new Uint8Array(Buffer.from(lines[1], "base64"));
}

export function readSecretKey(path: string, password: string): SigningKey {
  const decoded = decodeBody(path, "secret key");

  // 2 algorithm + 2 kdf + 2 cksum + 32 salt + 8 opslimit + 8 memlimit + 8 key id
  const HEADER_BYTES = 62;
  if (decoded.length < HEADER_BYTES + NONCE_BYTES) {
    throw new Error("secret key file too short");
  }

  let offset = 0;
  const read = (n: number) => {
    const slice = decoded.subarray(offset, offset + n);
    offset += n;
    return slice;
  };

  read(2); // algorithm
  read(2); // kdf
  read(2); // cksum — written but never validated, as in the Rust
  const kdfSalt = read(KDF_SALT_BYTES);
  const view = new DataView(decoded.buffer, decoded.byteOffset);
  const kdfOpslimit = view.getBigUint64(offset, true);
  offset += 8;
  const kdfMemlimit = view.getBigUint64(offset, true);
  offset += 8;
  const keyId = read(KEY_ID_BYTES);
  const encryptedKey = decoded.subarray(offset);

  // Cost parameters come from the file, not from the defaults, so keys written
  // under older parameters still open.
  const passwordHash = deriveEncryptionKey(
    password,
    kdfSalt,
    Number(kdfMemlimit),
    Number(kdfOpslimit),
  );

  const nonce = encryptedKey.subarray(0, NONCE_BYTES);
  const ciphertext = encryptedKey.subarray(NONCE_BYTES);
  const cipher = xchacha20poly1305(passwordHash, nonce);

  let plaintext: Uint8Array;
  try {
    plaintext = cipher.decrypt(ciphertext);
  } catch {
    // AEAD failure here almost always means a wrong password rather than a
    // corrupt file, so say that instead of surfacing a tag-mismatch error.
    throw new Error("could not decrypt secret key — wrong password?");
  }

  if (plaintext.length !== KEY_BYTES * 2) {
    throw new Error(`invalid plaintext length: ${plaintext.length}`);
  }

  return new SigningKey(plaintext.subarray(0, KEY_BYTES), new Uint8Array(keyId));
}

export function readSigFile(path: string): SigFile {
  const decoded = decodeBody(path, "signature");

  // 2 algorithm + 8 key id + 64 signature. The Rust checked for 72 here but
  // then sliced [10..74], which panics on a 72- or 73-byte body; the bound is
  // 74 and is corrected in this port.
  const MIN_BYTES = 2 + KEY_ID_BYTES + SIGNATURE_BYTES;
  if (decoded.length < MIN_BYTES) {
    throw new Error("signature file too short");
  }

  return {
    algorithm: new Uint8Array(decoded.subarray(0, 2)),
    keyId: new Uint8Array(decoded.subarray(2, 10)),
    globalSignature: new Uint8Array(decoded.subarray(10, 74)),
    trustedComment: "",
    commentSignature: new Uint8Array(SIGNATURE_BYTES),
  };
}

export function readPublicKey(path: string): VerifyingKey {
  const decoded = decodeBody(path, "public key");

  const MIN_BYTES = 2 + KEY_ID_BYTES + KEY_BYTES;
  if (decoded.length < MIN_BYTES) {
    throw new Error("public key too short");
  }

  const keyId = new Uint8Array(decoded.subarray(2, 10));
  const keyBytes = new Uint8Array(decoded.subarray(10, 42));
  return new VerifyingKey(keyBytes, keyId);
}

export { deriveKeyId };
