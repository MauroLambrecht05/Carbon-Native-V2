import { describe, expect, test } from "bun:test";
import { SignatureVerifier } from "../infrastructure/services/SignatureVerifier.ts";

describe("SignatureVerifier", () => {
  const verifier = SignatureVerifier.getInstance();

  test("computes sha256 checksum and verifies integrity", () => {
    const data = "Carbon desktop update payload v2.0.0";
    const hash = verifier.computeSha256(data);
    expect(hash.length).toBe(64);
    expect(verifier.verifySha256(data, hash)).toBe(true);
    expect(verifier.verifySha256("tampered payload", hash)).toBe(false);
  });

  test("verifies valid Ed25519 signature on manifest content", () => {
    const { publicKeyPem, signData } = verifier.createTestKeyPair();
    const manifestJson = JSON.stringify({ version: "2.0.0", channel: "stable" });
    const signature = signData(manifestJson);

    const valid = verifier.verifyEd25519(manifestJson, signature, publicKeyPem);
    expect(valid).toBe(true);
  });

  test("rejects invalid signature on tampered manifest content", () => {
    const { publicKeyPem, signData } = verifier.createTestKeyPair();
    const manifestJson = JSON.stringify({ version: "2.0.0", channel: "stable" });
    const signature = signData(manifestJson);

    // Tampered payload
    const tampered = JSON.stringify({ version: "2.0.0", channel: "hacked" });
    const valid = verifier.verifyEd25519(tampered, signature, publicKeyPem);
    expect(valid).toBe(false);
  });
});
