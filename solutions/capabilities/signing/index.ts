// @carbon/signing — proving an artifact came from us.
//
// Solves one set of related use cases: mint a signing identity, sign an
// artifact, verify one, rotate a key, and sign a release manifest.
//
//   domain/          keypairs, and the KeyStore interface
//   application/     one file per use case
//   infrastructure/  the minisign byte format — frozen, V1-compatible

export * from "./domain/value-objects/Keypair.ts";
export type { KeyStore } from "./domain/repositories/KeyStore.ts";
export { generate, type GenerateResult } from "./application/usecases/GenerateKeypairUseCase.ts";
export { signFile, type Purpose } from "./application/usecases/SignFileUseCase.ts";
export { verifyFile } from "./application/usecases/VerifyFileUseCase.ts";
export { rotateKeypair, rotateKeypair as rotate, DEFAULT_VALIDITY_WINDOW_DAYS } from "./application/usecases/RotateKeypairUseCase.ts";
export { signManifest, verifyManifest, verifyManifestFile, canonicalizeManifest } from "./application/usecases/SignManifestUseCase.ts";
export { readSecretKey, readPublicKey, readSigFile, writeKeypair, writeSigFile, writePublicKey, writeSecretKey, ALGORITHM } from "./infrastructure/MinisignKeyStore.ts";
export {
  signAuthenticode,
  AuthenticodeSignError,
  type AuthenticodeCredentials,
} from "./infrastructure/AuthenticodeSigner.ts";
