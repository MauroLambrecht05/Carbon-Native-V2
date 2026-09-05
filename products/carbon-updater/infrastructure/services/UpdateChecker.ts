// Update Checker: Evaluates manifest version, stop-list yanking,
// and deterministic rollout percentage bucketing.

import { createHash } from "node:crypto";
import { SignatureVerifier } from "./SignatureVerifier.ts";

export interface PlatformUpdate {
  readonly url: string;
  readonly sha256: string;
  readonly signature?: string;
}

export interface UpdaterManifest {
  readonly version: string;
  readonly pub_date: string;
  readonly channel: string;
  readonly rollout: number; // percentage 0 - 100
  readonly min_version?: string;
  readonly notes: string;
  readonly platforms: Record<string, PlatformUpdate>;
}

export interface CheckUpdateOptions {
  readonly currentVersion: string;
  readonly targetPlatform: string; // e.g. "windows-x86_64", "macos-arm64", "linux-x86_64"
  readonly installationId: string;
  readonly manifestUrl: string;
  readonly trustedPublicKey: string;
  readonly stopListUrl?: string;
  readonly mockManifestJson?: string;
  readonly mockManifestSig?: string;
  readonly mockStopList?: string[];
}

export interface CheckUpdateResult {
  readonly updateAvailable: boolean;
  readonly isYanked: boolean;
  readonly qualifiesForRollout: boolean;
  readonly newVersion?: string;
  readonly downloadUrl?: string;
  readonly sha256?: string;
  readonly notes?: string;
  readonly reason?: string;
}

export class UpdateChecker {
  private static instance: UpdateChecker;
  private readonly verifier = SignatureVerifier.getInstance();

  static getInstance(): UpdateChecker {
    if (!UpdateChecker.instance) {
      UpdateChecker.instance = new UpdateChecker();
    }
    return UpdateChecker.instance;
  }

  /**
   * Deterministic hash bucketing: installationId -> SHA256 -> int % 100.
   * Ensures the same device consistently falls into the exact same rollout bucket.
   */
  computeRolloutBucket(installationId: string): number {
    const hash = createHash("sha256").update(installationId).digest("hex");
    const num = parseInt(hash.slice(0, 8), 16);
    return num % 100;
  }

  /**
   * Compares two semver strings: returns true if candidate > current.
   */
  isVersionNewer(candidate: string, current: string): boolean {
    const parse = (v: string) => v.split(/[-+]/)[0].split(".").map(Number);
    const [cMaj, cMin, cPat] = parse(candidate);
    const [oMaj, oMin, oPat] = parse(current);

    if (cMaj !== oMaj) return cMaj > oMaj;
    if (cMin !== oMin) return cMin > oMin;
    return cPat > oPat;
  }

  async checkUpdate(options: CheckUpdateOptions): Promise<CheckUpdateResult> {
    // 1. Check Stop-List (Yanked versions)
    let yankedList: string[] = options.mockStopList || [];
    if (!options.mockStopList && options.stopListUrl) {
      try {
        const res = await fetch(options.stopListUrl);
        if (res.ok) {
          const data = (await res.json()) as { yanked?: string[] } | string[];
          yankedList = Array.isArray(data) ? data : data.yanked || [];
        }
      } catch {}
    }

    if (yankedList.includes(options.currentVersion)) {
      return {
        updateAvailable: false,
        isYanked: true,
        qualifiesForRollout: true,
        reason: `Current version ${options.currentVersion} is yanked due to a known issue. Forced update required.`,
      };
    }

    // 2. Fetch Manifest and Signature
    let manifestText = options.mockManifestJson;
    let signature = options.mockManifestSig;

    if (!manifestText) {
      const res = await fetch(options.manifestUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch updater manifest: HTTP ${res.status}`);
      }
      manifestText = await res.text();

      // Fetch signature if available
      try {
        const sigRes = await fetch(`${options.manifestUrl}.sig`);
        if (sigRes.ok) signature = await sigRes.text();
      } catch {}
    }

    // 3. Verify Signature if signature is provided
    if (signature) {
      const validSig = this.verifier.verifyEd25519(manifestText, signature.trim(), options.trustedPublicKey);
      if (!validSig) {
        throw new Error("Cryptographic verification failed: Manifest signature is invalid or forged.");
      }
    }

    const manifest = JSON.parse(manifestText) as UpdaterManifest;

    // 4. Platform check
    const platformEntry = manifest.platforms[options.targetPlatform];
    if (!platformEntry) {
      return {
        updateAvailable: false,
        isYanked: false,
        qualifiesForRollout: false,
        reason: `No installer available for platform ${options.targetPlatform}`,
      };
    }

    // 5. Version comparison
    const isNewer = this.isVersionNewer(manifest.version, options.currentVersion);
    if (!isNewer) {
      return {
        updateAvailable: false,
        isYanked: false,
        qualifiesForRollout: false,
        reason: `Already on the latest version (${options.currentVersion})`,
      };
    }

    // 6. Rollout percentage check
    const bucket = this.computeRolloutBucket(options.installationId);
    const rolloutThreshold = manifest.rollout ?? 100;
    const qualifies = bucket < rolloutThreshold;

    if (!qualifies) {
      return {
        updateAvailable: false,
        isYanked: false,
        qualifiesForRollout: false,
        newVersion: manifest.version,
        reason: `Target version is in staged rollout (${rolloutThreshold}%). Device bucket ${bucket} is not yet selected.`,
      };
    }

    return {
      updateAvailable: true,
      isYanked: false,
      qualifiesForRollout: true,
      newVersion: manifest.version,
      downloadUrl: platformEntry.url,
      sha256: platformEntry.sha256,
      notes: manifest.notes,
    };
  }
}
