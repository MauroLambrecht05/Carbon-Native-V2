// Cryptographic Signature Verifier for Carbon Updater.
// Enforces Ed25519 signature checks on manifests and SHA-256 on update payloads.

import { createHash, verify, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

export class SignatureVerifier {
  private static instance: SignatureVerifier;

  static getInstance(): SignatureVerifier {
    if (!SignatureVerifier.instance) {
      SignatureVerifier.instance = new SignatureVerifier();
    }
    return SignatureVerifier.instance;
  }

  computeSha256(content: string | Uint8Array): string {
    return createHash("sha256").update(content).digest("hex");
  }

  verifySha256(content: string | Uint8Array, expectedHash: string): boolean {
    const actual = this.computeSha256(content);
    return actual.toLowerCase() === expectedHash.toLowerCase();
  }

  /**
   * Verifies an Ed25519 signature against data.
   * Accepts PEM public key, SPKI public key, or raw 32-byte public key in base64/hex.
   */
  verifyEd25519(
    data: string | Uint8Array,
    signatureBase64OrHex: string,
    publicKeySpkiOrPem: string,
  ): boolean {
    try {
      const dataBuf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      const isHex = /^[0-9a-fA-F]+$/.test(signatureBase64OrHex) && signatureBase64OrHex.length % 2 === 0;
      const sigBuf = isHex
        ? Buffer.from(signatureBase64OrHex, "hex")
        : Buffer.from(signatureBase64OrHex, "base64");

      let keyObject;
      if (publicKeySpkiOrPem.includes("BEGIN PUBLIC KEY")) {
        keyObject = createPublicKey(publicKeySpkiOrPem);
      } else {
        // Try DER/SPKI base64 or hex
        const keyBuf = /^[0-9a-fA-F]+$/.test(publicKeySpkiOrPem)
          ? Buffer.from(publicKeySpkiOrPem, "hex")
          : Buffer.from(publicKeySpkiOrPem, "base64");

        // If 32 bytes (raw Ed25519), wrap with SPKI header: 302a300506032b6570032100 + rawKey
        if (keyBuf.length === 32) {
          const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
          const fullSpki = Buffer.concat([spkiHeader, keyBuf]);
          keyObject = createPublicKey({ key: fullSpki, format: "der", type: "spki" });
        } else {
          keyObject = createPublicKey({ key: keyBuf, format: "der", type: "spki" });
        }
      }

      return verify(null, dataBuf, keyObject, sigBuf);
    } catch {
      return false;
    }
  }

  /**
   * Helper utility for testing: generates a keypair and signs a manifest string.
   */
  createTestKeyPair(): {
    publicKeyPem: string;
    publicKeyRawBase64: string;
    privateKeyPem: string;
    signData: (data: string | Uint8Array) => string;
  } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    // Extract raw 32 bytes (last 32 bytes of 44-byte SPKI DER)
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    const rawPub = spkiDer.subarray(spkiDer.length - 32).toString("base64");

    return {
      publicKeyPem,
      publicKeyRawBase64: rawPub,
      privateKeyPem,
      signData: (data: string | Uint8Array) => {
        const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
        return sign(null, buf, privateKey).toString("base64");
      },
    };
  }
}
