// Ed25519 signing for published plugin tarballs — the server-side half of
// solutions/capabilities/plugin/trust/rust's signing scheme, reimplemented
// here because carbon-registry runs on Bun with no Rust toolchain in its
// container. Same content-hash algorithm (SHA-256 of the raw artifact
// bytes IS the message Ed25519 signs, never the bytes themselves — see
// that crate's ContentHash/signing.rs), same raw 64-byte detached
// signature, same raw 32/32-byte key format as
// solutions/capabilities/plugin/trust/rust/infrastructure/keyfile.rs's
// `~/.carbon/keys/plugin-signing.key` — a signature this module produces
// verifies under the identical Rust `verify_bytes`/`verify_artifact`, and
// vice versa, with no format translation, because Ed25519 (RFC 8032) is
// deterministic and both are spec-compliant implementations. Verified
// directly: signed here, verified with Node/Bun's own `crypto.verify`
// against a public key reconstructed from nothing but its raw 32 bytes,
// the same way a downloader who only has the hex string over HTTP would.

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, type KeyObject } from "node:crypto";

const SEED_LENGTH = 32;

// RFC 8410's Ed25519 PKCS8 encoding has no variable-length field besides
// the seed itself, so this fixed 16-byte prefix + a raw 32-byte seed is
// the entire DER document — the standard trick for importing a raw seed
// (this repo's own keyfile.rs private-key format) into Node/Bun's crypto,
// which otherwise only accepts PEM/DER/JWK, never a bare seed.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface SignedContent {
  readonly signatureBase64: string;
  readonly checksumSha256: string;
}

export class TrustSigner {
  private readonly privateKey: KeyObject;
  readonly publicKeyHex: string;

  private constructor(seed: Buffer) {
    const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
    this.privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    const jwk = createPublicKey(this.privateKey).export({ format: "jwk" }) as { x: string };
    this.publicKeyHex = Buffer.from(jwk.x, "base64url").toString("hex");
  }

  /**
   * `seedHex`: a 64-hex-character Ed25519 seed — the exact format
   * `carbon-plugin-sign keygen` writes. Undefined mints a random
   * ephemeral key instead: every restart then signs under a NEW key,
   * which is fine for local dev/tests but never what a real deployment
   * should run on — callers must log loudly when this branch is taken
   * (see entrypoint.ts), the same way FakeCheckoutSessionProvider's own
   * call site does for a missing STRIPE_SECRET_KEY.
   */
  static fromHexSeed(seedHex: string | undefined): TrustSigner {
    if (!seedHex) {
      return new TrustSigner(randomBytes(SEED_LENGTH));
    }
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) {
      throw new Error(
        `CARBON_TRUST_PRIVATE_KEY must be exactly ${SEED_LENGTH * 2} hex characters (a raw Ed25519 seed, e.g. from "carbon-plugin-sign keygen")`,
      );
    }
    return new TrustSigner(Buffer.from(seedHex, "hex"));
  }

  sign(content: Uint8Array): SignedContent {
    const digest = createHash("sha256").update(content).digest();
    const signature = edSign(null, digest, this.privateKey);
    return { signatureBase64: signature.toString("base64"), checksumSha256: digest.toString("hex") };
  }
}
