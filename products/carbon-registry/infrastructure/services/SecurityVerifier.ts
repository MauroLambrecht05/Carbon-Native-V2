// Security Verifier: Enforces package naming standards, semver format,
// SHA-256 checksum integrity, and manifest contracts.

import { createHash } from "crypto";

export interface PluginManifest {
  name: string;
  version: string;
  category: string;
  description: string;
  abiVersion?: string;
  platforms?: string[];
  permissions?: string[];
}

export class SecurityVerifier {
  private static instance: SecurityVerifier;

  static getInstance(): SecurityVerifier {
    if (!SecurityVerifier.instance) {
      SecurityVerifier.instance = new SecurityVerifier();
    }
    return SecurityVerifier.instance;
  }

  validatePluginName(name: string): boolean {
    // lowercase alphanumeric with hyphens, 2-50 chars
    const pattern = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
    return pattern.test(name);
  }

  validateSemver(version: string): boolean {
    const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    return pattern.test(version);
  }

  computeSha256(content: string | Uint8Array): string {
    return createHash("sha256").update(content).digest("hex");
  }

  verifyChecksum(content: string | Uint8Array, expectedChecksum: string): boolean {
    const actual = this.computeSha256(content);
    return actual.toLowerCase() === expectedChecksum.toLowerCase();
  }

  validateManifest(manifest: Partial<PluginManifest>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!manifest.name || !this.validatePluginName(manifest.name)) {
      errors.push("Invalid plugin name: must be 2-50 lowercase alphanumeric characters with hyphens");
    }

    if (!manifest.version || !this.validateSemver(manifest.version)) {
      errors.push("Invalid version: must follow standard semver (e.g. 1.0.0)");
    }

    if (!manifest.description || manifest.description.trim().length < 5) {
      errors.push("Description must be at least 5 characters long");
    }

    if (!manifest.category) {
      errors.push("Category is required (e.g. carbon-desktop, carbon-dev, carbon-security)");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
