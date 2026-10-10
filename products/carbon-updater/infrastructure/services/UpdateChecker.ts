// Update Checker: fetches a channel's manifest, signature and stop list, and
// asks the shared updater rules what to do.
//
// The rules themselves (version ordering, rollout bucket, stop list,
// compatibility, channel) are @carbon/updating's, the same ones the Rust
// runtime updater implements, and both are held to the conformance fixture in
// solutions/contracts/update/fixtures. This file must not grow rules of its
// own: an earlier version did, and bucketed installs differently from every
// other consumer.

import { compareVersions, decideUpdate, type StopListData } from "@carbon/updating";
import type { UpdaterManifest } from "@carbon/contracts/update";
import { SignatureVerifier } from "./SignatureVerifier.ts";

export type { UpdaterManifest };

export interface CheckUpdateOptions {
  readonly currentVersion: string;
  readonly targetPlatform: string; // the manifest's platform key, e.g. "x86_64-pc-windows-msvc"
  readonly installationId: string;
  readonly manifestUrl: string;
  readonly trustedPublicKey: string;
  /** The channel this install follows. A manifest for another channel is ignored. */
  readonly channel?: string;
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

const REASONS: Record<string, string> = {
  channel_mismatch: "The manifest is for another channel",
  invalid_version: "A version could not be compared",
  current: "Already on the latest version",
  older: "The offered version is older than the running version",
  withdrawn: "The offered version has been withdrawn",
  incompatible: "The running version is too old to update directly to the offered version",
  no_platform: "No installer is available for this platform",
  not_in_rollout: "The offered version is in staged rollout and this device is not yet selected",
};

export class UpdateChecker {
  private static instance: UpdateChecker;
  private readonly verifier = SignatureVerifier.getInstance();

  static getInstance(): UpdateChecker {
    if (!UpdateChecker.instance) {
      UpdateChecker.instance = new UpdateChecker();
    }
    return UpdateChecker.instance;
  }

  /** True when `candidate` has higher precedence than `current`. Anything that is not a version is not newer. */
  isVersionNewer(candidate: string, current: string): boolean {
    return (compareVersions(candidate, current) ?? 0) > 0;
  }

  private async stopList(options: CheckUpdateOptions): Promise<StopListData> {
    let versions: unknown = options.mockStopList;
    if (!versions && options.stopListUrl) {
      const response = await fetch(options.stopListUrl);
      // No stop list published yet means nothing is withdrawn. Any other failure is an error, not an empty list.
      if (response.status === 404) versions = [];
      else if (!response.ok) throw new Error(`Failed to fetch the stop list: HTTP ${response.status}`);
      else { const data = (await response.json()) as { yanked?: unknown } | unknown[]; versions = Array.isArray(data) ? data : data.yanked ?? []; }
    }
    const yanked = (Array.isArray(versions) ? versions : []).map((entry) =>
      typeof entry === "string" ? { version: entry, reason: null, yanked_at: "" } : (entry as StopListData["yanked"][number]));
    return { yanked, generated_at: "" };
  }

  async checkUpdate(options: CheckUpdateOptions): Promise<CheckUpdateResult> {
    // 1. The manifest and its signature. An unsigned manifest is never accepted.
    let manifestText = options.mockManifestJson;
    let signature = options.mockManifestSig;
    if (!manifestText) {
      const response = await fetch(options.manifestUrl);
      if (!response.ok) throw new Error(`Failed to fetch updater manifest: HTTP ${response.status}`);
      manifestText = await response.text();
      const signed = await fetch(options.manifestUrl.replace(/\.json$/, ".sig"));
      if (signed.ok) signature = await signed.text();
    }
    if (!signature) throw new Error("Cryptographic verification failed: the manifest has no signature.");
    // The signature covers the fetched bytes, checked against the key this install pins, never a key the manifest names.
    if (!this.verifier.verifyEd25519(manifestText, signature.trim(), options.trustedPublicKey)) {
      throw new Error("Cryptographic verification failed: Manifest signature is invalid or forged.");
    }
    const manifest = JSON.parse(manifestText) as UpdaterManifest;

    // 2. The shared decision.
    const decision = decideUpdate({ manifest, stopList: await this.stopList(options), currentVersion: options.currentVersion, installationId: options.installationId,
      platform: options.targetPlatform, ...(options.channel === undefined ? {} : { channel: options.channel }) });
    if (decision.action === "rollback") {
      return { updateAvailable: false, isYanked: true, qualifiesForRollout: true, reason: `Current version ${options.currentVersion} is yanked due to a known issue. Roll back to the previous version.` };
    }
    if (decision.action === "none") {
      return { updateAvailable: false, isYanked: false, qualifiesForRollout: false, ...(decision.reason === "not_in_rollout" ? { newVersion: manifest.version } : {}), reason: REASONS[decision.reason] };
    }
    return { updateAvailable: true, isYanked: false, qualifiesForRollout: true, newVersion: decision.version, downloadUrl: decision.artifact.url, sha256: decision.artifact.sha256, notes: manifest.notes };
  }
}
