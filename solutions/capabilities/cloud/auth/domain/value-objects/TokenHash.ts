// SHA-256 of a magic-link/session token — not bcrypt/argon2, deliberately.
// Same reasoning as @carbon/identity's own TokenHash.ts (a copy, not a
// shared import: this capability owns its own primitives rather than
// taking a cross-capability dependency for one hash function): the token
// is generated high-entropy (a UUID's worth of randomness), so a fast
// hash costs an attacker nothing extra to check but costs every request
// nothing to verify.

export function hashToken(plaintext: string): string {
  return new Bun.CryptoHasher("sha256").update(plaintext).digest("hex");
}
