// SHA-256 of an API token — not bcrypt/argon2, deliberately: those defend
// against brute-forcing a LOW-entropy human password. An API token is
// generated high-entropy (32 random bytes, see IssueTokenUseCase), so a fast
// hash costs an attacker nothing extra to check but costs every request
// nothing to verify — the tradeoff argon2 makes is the wrong one here.

export function hashToken(plaintext: string): string {
  return new Bun.CryptoHasher("sha256").update(plaintext).digest("hex");
}
