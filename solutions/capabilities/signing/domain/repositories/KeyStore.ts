// Where signing keys and signatures live.
//
// The implementation is the minisign byte format on disk
// (infrastructure/crypto/MinisignKeyStore.ts). Keeping it behind an interface
// is what stops the *format* leaking into the signing use cases — the format
// must stay byte-compatible with V1's Rust crate, and the use cases must be
// free to change.

import type { SigningKey, VerifyingKey } from "../value-objects/Keypair.ts";

export interface KeyStore {
  writeKeypair(
    signingKey: SigningKey,
    verifyingKey: VerifyingKey,
    name: string,
    password: string,
    outDir: string,
  ): { pubkeyPath: string; seckeyPath: string };

  readSecretKey(path: string, password: string): SigningKey;
  readPublicKey(path: string): VerifyingKey;

  writeSignature(signature: Uint8Array, keyId: Uint8Array, path: string): void;
  readSignature(path: string): Uint8Array;
}
