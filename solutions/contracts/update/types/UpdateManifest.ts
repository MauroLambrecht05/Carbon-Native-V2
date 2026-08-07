// The manifest shape as the updater reads it.
//
// Ported from V1 tools/updater/src/manifest.rs. This duplicates the structs in
// @carbon/signer's manifest module, exactly as the two Rust crates duplicated
// them — the signer writes manifests, the updater consumes them, and giving
// either a dependency on the other would couple the release tooling to the
// shipped client.

export interface KeyringEntry {
  primary: string;
  secondary: string | null;
  secondary_signed_by_primary?: string;
  validity_window_days: number;
}

export interface PlatformEntry {
  signature: string;
  url: string;
  sha256: string;
}

export interface UpdaterManifest {
  version: string;
  pub_date: string;
  notes: string;
  channel: string;
  min_version: string | null;
  rollout: number;
  keyring: KeyringEntry;
  platforms: Record<string, PlatformEntry>;
}

export function parseManifest(json: string): UpdaterManifest {
  return JSON.parse(json) as UpdaterManifest;
}
