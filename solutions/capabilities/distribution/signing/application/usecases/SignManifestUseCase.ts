// Use case: sign and verify an updater manifest.
//
// Ported from V1 tools/signer/src/manifest.rs. The manifest shape is
// duplicated by the updates capability (V1 duplicated it too — an identical
// struct in tools/updater/src/manifest.rs) because signing writes manifests
// and updates reads them, and neither should depend on the other.

import { readFileSync } from "node:fs";
import type { VerifyingKey } from "../../domain/value-objects/Keypair.ts";
import { readSecretKey } from "../../infrastructure/MinisignKeyStore.ts";

export interface KeyringEntry {
  primary: string;
  secondary: string | null;
  /** Omitted from the signed bytes when absent (serde `skip_serializing_if`). */
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

/**
 * Serializes a manifest to the exact bytes that get signed.
 *
 * This has to be spelled out rather than left to `JSON.stringify(manifest)`,
 * because the signature covers a byte string and Rust's serde emitted fields
 * in struct-declaration order. An object built in a different order would
 * serialize to different bytes and fail to verify against a V1-signed
 * manifest, even though the two are the same manifest.
 *
 * Note the same reasoning exposes a flaw inherited from V1: `platforms` was a
 * Rust `HashMap`, whose iteration order is randomized per process, so a
 * multi-platform manifest signed by V1 could serialize differently on a
 * re-sign. Insertion order is used here, which is at least deterministic.
 */
export function canonicalizeManifest(manifest: UpdaterManifest): string {
  const keyring: Record<string, unknown> = {
    primary: manifest.keyring.primary,
    secondary: manifest.keyring.secondary ?? null,
  };
  if (manifest.keyring.secondary_signed_by_primary !== undefined) {
    keyring.secondary_signed_by_primary = manifest.keyring.secondary_signed_by_primary;
  }
  keyring.validity_window_days = manifest.keyring.validity_window_days;

  const platforms: Record<string, PlatformEntry> = {};
  for (const [name, entry] of Object.entries(manifest.platforms)) {
    platforms[name] = { signature: entry.signature, url: entry.url, sha256: entry.sha256 };
  }

  return JSON.stringify({
    version: manifest.version,
    pub_date: manifest.pub_date,
    notes: manifest.notes,
    channel: manifest.channel,
    min_version: manifest.min_version ?? null,
    rollout: manifest.rollout,
    keyring,
    platforms,
  });
}

/**
 * Signs raw bytes with the secret key at `keyFile`; returns base64.
 *
 * Shared primitive: `signManifest` below canonicalizes a manifest to bytes
 * first, and `PublishReleaseUseCase` (solutions/capabilities/distribution/
 * publishing) calls this directly to sign a built installer artifact's own
 * bytes for its manifest `platforms[...].signature` entry — same key,
 * same raw ed25519-over-bytes-then-base64 shape, no manifest involved.
 */
export function signBytes(bytes: Uint8Array, keyFile: string, password: string): string {
  const sk = readSecretKey(keyFile, password);
  return Buffer.from(sk.sign(bytes)).toString("base64");
}

/** Signs a manifest with the secret key at `keyFile`; returns base64. */
export function signManifest(
  manifest: UpdaterManifest,
  keyFile: string,
  password: string,
): string {
  return signBytes(new TextEncoder().encode(canonicalizeManifest(manifest)), keyFile, password);
}

/**
 * Verifies `sig` over the raw manifest JSON and returns the parsed manifest.
 *
 * Takes the JSON as a string, not a parsed object, because the signature
 * covers the bytes that were fetched — re-serializing a parsed manifest and
 * verifying that instead would accept a manifest whose bytes were tampered
 * with in any way the parser normalizes away.
 */
export function verifyManifest(
  manifestJson: string,
  sig: string,
  pubkey: VerifyingKey,
): UpdaterManifest {
  const sigBytes = new Uint8Array(Buffer.from(sig, "base64"));
  if (sigBytes.length !== 64) {
    throw new Error("invalid signature length");
  }

  pubkey.verify(new TextEncoder().encode(manifestJson), sigBytes);

  return JSON.parse(manifestJson) as UpdaterManifest;
}

/** Convenience for the common "verify a manifest on disk" path. */
export function verifyManifestFile(
  path: string,
  sig: string,
  pubkey: VerifyingKey,
): UpdaterManifest {
  return verifyManifest(readFileSync(path, "utf8"), sig, pubkey);
}
