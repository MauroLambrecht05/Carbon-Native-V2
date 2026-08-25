// A plugin's content hash — its identity for both signing and revocation.
//
// One type rather than a loose `[u8; 32]` so that "the thing that was signed"
// and "the thing the revocation list names" cannot drift apart: they are the
// same value, produced by the same constructor, and the hex rendering that goes
// into the revocation list is this type's `Display`.

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use std::fmt;

/// SHA-256, so 32 bytes.
pub const CONTENT_HASH_LEN: usize = 32;

/// The SHA-256 of a compiled plugin artifact's bytes.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContentHash([u8; CONTENT_HASH_LEN]);

impl ContentHash {
    /// Hash an artifact's bytes. This is the ONLY way to make one from content,
    /// so signer and loader cannot disagree about what gets hashed.
    pub fn of(bytes: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        Self(hasher.finalize().into())
    }

    /// The raw digest — this is the message Ed25519 signs.
    pub fn as_bytes(&self) -> &[u8; CONTENT_HASH_LEN] {
        &self.0
    }

    /// Lowercase hex, which is the form the revocation list is written in and
    /// the form `carbon-plugin-sign` prints.
    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(CONTENT_HASH_LEN * 2);
        for b in self.0 {
            s.push(nibble(b >> 4));
            s.push(nibble(b & 0x0f));
        }
        s
    }

    /// Parse the hex form. Used by the revocation list and by
    /// `carbon-plugin-sign verify --expect-hash`.
    pub fn parse_hex(text: &str) -> Result<Self> {
        let text = text.trim();
        let bytes = decode_hex(text, CONTENT_HASH_LEN)
            .ok_or_else(|| anyhow!("not a {CONTENT_HASH_LEN}-byte hex digest: `{text}`"))?;
        let mut out = [0u8; CONTENT_HASH_LEN];
        out.copy_from_slice(&bytes);
        Ok(Self(out))
    }
}

impl fmt::Display for ContentHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for ContentHash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ContentHash({})", self.to_hex())
    }
}

// ── Hex, hand-rolled ───────────────────────────────────────────────────────
// Twenty lines against a dependency that the LOADER would then also link, on
// the path that runs before any plugin code does. The smaller that path's
// dependency graph is, the smaller the supply-chain surface of the thing whose
// entire job is supply-chain safety.

fn nibble(v: u8) -> char {
    char::from(if v < 10 { b'0' + v } else { b'a' + (v - 10) })
}

/// Decode `expected_len` bytes of hex, or `None` if the length or any digit is
/// wrong. Accepts either case; emits only lowercase.
pub fn decode_hex(text: &str, expected_len: usize) -> Option<Vec<u8>> {
    let raw = text.as_bytes();
    if raw.len() != expected_len * 2 {
        return None;
    }
    let mut out = Vec::with_capacity(expected_len);
    for pair in raw.chunks_exact(2) {
        let hi = unhex(pair[0])?;
        let lo = unhex(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

/// Lowercase hex for an arbitrary byte string — public keys and signatures,
/// which are not `ContentHash`es but are written in the same form.
pub fn encode_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(nibble(b >> 4));
        s.push(nibble(b & 0x0f));
    }
    s
}

fn unhex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_the_known_empty_vector() {
        // The published SHA-256 of the empty string. If this ever changes, the
        // digest the loader checks is not the digest the signer produced.
        assert_eq!(
            ContentHash::of(b"").to_hex(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn one_flipped_byte_changes_the_hash() {
        assert_ne!(ContentHash::of(b"plugin"), ContentHash::of(b"pluginn"));
        assert_ne!(ContentHash::of(&[0u8, 1, 2]), ContentHash::of(&[0u8, 1, 3]));
    }

    #[test]
    fn hex_round_trips_and_rejects_junk() {
        let h = ContentHash::of(b"carbon");
        assert_eq!(ContentHash::parse_hex(&h.to_hex()).unwrap(), h);
        assert!(ContentHash::parse_hex("abcd").is_err());
        assert!(ContentHash::parse_hex(&"zz".repeat(32)).is_err());
    }
}
