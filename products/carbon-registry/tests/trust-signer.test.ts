import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { TrustSigner } from "../infrastructure/services/TrustSigner.ts";

// Reconstructs a public key from nothing but its raw hex bytes — exactly
// what a downloader who only received `publicKeyHex` over HTTP has to do,
// proving the format is really the interoperable raw-32-byte kind, not
// something only this same process can decode back.
function verifyRaw(content: Uint8Array, signatureBase64: string, publicKeyHex: string): boolean {
  const digest = createHash("sha256").update(content).digest();
  const x = Buffer.from(publicKeyHex, "hex").toString("base64url");
  const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x } as any, format: "jwk" });
  return edVerify(null, digest, publicKey, Buffer.from(signatureBase64, "base64"));
}

describe("TrustSigner", () => {
  test("a fixed hex seed always derives the same public key", () => {
    const seed = "07".repeat(32);
    const a = TrustSigner.fromHexSeed(seed);
    const b = TrustSigner.fromHexSeed(seed);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(a.publicKeyHex).toHaveLength(64);
  });

  test("two different seeds derive different public keys", () => {
    const a = TrustSigner.fromHexSeed("11".repeat(32));
    const b = TrustSigner.fromHexSeed("22".repeat(32));
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });

  test("rejects a seed that isn't exactly 64 hex characters", () => {
    expect(() => TrustSigner.fromHexSeed("not-hex")).toThrow();
    expect(() => TrustSigner.fromHexSeed("ab")).toThrow();
    expect(() => TrustSigner.fromHexSeed("zz".repeat(32))).toThrow();
  });

  test("undefined seed mints a usable ephemeral key", () => {
    const signer = TrustSigner.fromHexSeed(undefined);
    expect(signer.publicKeyHex).toHaveLength(64);
    const content = Buffer.from("ephemeral dev key still signs real bytes");
    const { signatureBase64 } = signer.sign(content);
    expect(verifyRaw(content, signatureBase64, signer.publicKeyHex)).toBe(true);
  });

  test("a real signature verifies against a public key reconstructed from raw hex alone", () => {
    const signer = TrustSigner.fromHexSeed("42".repeat(32));
    const content = Buffer.from("pretend this is a published plugin tarball");
    const { signatureBase64, checksumSha256 } = signer.sign(content);

    expect(checksumSha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(verifyRaw(content, signatureBase64, signer.publicKeyHex)).toBe(true);
  });

  test("refuses a tampered payload", () => {
    const signer = TrustSigner.fromHexSeed("99".repeat(32));
    const content = Buffer.from("original bytes");
    const { signatureBase64 } = signer.sign(content);

    const tampered = Buffer.from("original bytef");
    expect(verifyRaw(tampered, signatureBase64, signer.publicKeyHex)).toBe(false);
  });

  test("refuses a signature from a different key", () => {
    const signerA = TrustSigner.fromHexSeed("aa".repeat(32));
    const signerB = TrustSigner.fromHexSeed("bb".repeat(32));
    const content = Buffer.from("same content, different signer");
    const { signatureBase64 } = signerA.sign(content);

    expect(verifyRaw(content, signatureBase64, signerB.publicKeyHex)).toBe(false);
  });
});
