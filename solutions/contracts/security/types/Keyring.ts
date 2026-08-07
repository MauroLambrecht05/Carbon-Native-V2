// The keyring, and the on-disk shape of a signature.
//
// This crosses two capabilities: `signing` produces both — it mints keypairs,
// rotates them into a keyring and writes .sig files — and `updating` consumes
// both, verifying a downloaded artifact against a key it trusts. Neither owns
// the format, so it lives here.
//
// The byte layout is minisign's, and it is frozen. Signatures already exist in
// released artifacts; a change here does not break a build, it breaks the
// ability to verify something that shipped last year.

/** What a signature covers, so an app signature cannot be replayed as a plugin one. */
export type Purpose = "app" | "plugin";

/**
 * Key rotation, as published to clients.
 *
 * Rotation cannot be a swap: an installed app trusts exactly one key, and an
 * artifact signed with a new one it has never seen is indistinguishable from an
 * attack. So the new key is cross-signed by the old, and both are valid for a
 * window during which clients adopt the new one.
 */
export interface Keyring {
  /** Base64 verifying key currently used to sign releases. */
  readonly primary: string;
  /** The outgoing key, still accepted until the window closes. Null before any rotation. */
  readonly secondary: string | null;
  /**
   * Signature over `secondary`'s replacement, made with the outgoing key.
   *
   * This is what lets a client that only knows the old key accept the new one:
   * the proof of continuity is signed by something it already trusts.
   */
  readonly secondary_signed_by_primary: string | null;
  /** How long the outgoing key stays valid. */
  readonly validity_window_days: number;
}

/**
 * Byte lengths of the minisign forms, after base64 decoding.
 *
 * Asserted in the signing tests. They are here rather than in the capability
 * because they are the agreement — a file of the wrong length is not a
 * different implementation, it is an incompatible one.
 */
export const MINISIGN_BYTES = {
  /** algorithm(2) + key id(8) + public key(32) */
  publicKey: 42,
  /** 3 tags(6) + salt(32) + limits(16) + key id(8) + nonce(24) + sealed(80) */
  secretKey: 166,
  /** algorithm(2) + key id(8) + signature(64) */
  signature: 74,
} as const;

export const KEYRING_DEFAULT_VALIDITY_WINDOW_DAYS = 90;
