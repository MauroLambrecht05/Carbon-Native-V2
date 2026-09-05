import { describe, expect, test } from "bun:test";
import { SecurityVerifier } from "../infrastructure/services/SecurityVerifier.ts";

describe("SecurityVerifier", () => {
  const verifier = SecurityVerifier.getInstance();

  test("validates compliant and non-compliant plugin names", () => {
    expect(verifier.validatePluginName("clipboard")).toBe(true);
    expect(verifier.validatePluginName("audio-player")).toBe(true);
    expect(verifier.validatePluginName("carbon-sqlite-3")).toBe(true);

    // Invalid
    expect(verifier.validatePluginName("A")).toBe(false); // too short
    expect(verifier.validatePluginName("Clipboard")).toBe(false); // uppercase
    expect(verifier.validatePluginName("audio_player")).toBe(false); // underscores not allowed
    expect(verifier.validatePluginName("-invalid")).toBe(false); // leading hyphen
  });

  test("validates semver versions", () => {
    expect(verifier.validateSemver("1.0.0")).toBe(true);
    expect(verifier.validateSemver("0.1.2-alpha.1")).toBe(true);
    expect(verifier.validateSemver("2.4.15+build.2026")).toBe(true);

    // Invalid
    expect(verifier.validateSemver("1")).toBe(false);
    expect(verifier.validateSemver("v1.0.0")).toBe(false);
    expect(verifier.validateSemver("latest")).toBe(false);
  });

  test("computes sha256 checksum and verifies integrity", () => {
    const data = "sample plugin payload";
    const checksum = verifier.computeSha256(data);
    expect(checksum.length).toBe(64);

    expect(verifier.verifyChecksum(data, checksum)).toBe(true);
    expect(verifier.verifyChecksum("tampered data", checksum)).toBe(false);
  });

  test("validates complete manifest", () => {
    const valid = verifier.validateManifest({
      name: "keychain",
      version: "1.0.0",
      category: "carbon-security",
      description: "Secure hardware-backed credential storage",
    });
    expect(valid.valid).toBe(true);
    expect(valid.errors.length).toBe(0);

    const invalid = verifier.validateManifest({
      name: "INVALID_NAME",
      version: "bad-version",
      category: "",
      description: "sh",
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.length).toBeGreaterThanOrEqual(3);
  });
});
