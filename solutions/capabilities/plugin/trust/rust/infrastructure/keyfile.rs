// The private key on disk.
//
// ── THE KEY NEVER LIVES IN THE REPOSITORY ───────────────────────────────────
// Not in a fixture, not in a test, not base64'd into a comment. `default_path`
// resolves OUTSIDE any checkout on purpose, and `generate` refuses to write over
// an existing key file, because the one unrecoverable mistake here is silently
// replacing the key that every already-published plugin was signed with.
//
// This is also the only module in the crate that the runtime does not compile
// into an app: nothing on the verification path references it, so a shipped
// binary contains no code that knows what a Carbon private key looks like.
//
// ── FORMAT ──────────────────────────────────────────────────────────────────
// One line of 64 lowercase hex characters: the 32-byte Ed25519 seed. Blank
// lines and `#` comments are skipped so the file can carry a "this is secret"
// header without a parser that needs a spec.
//
// Not PKCS#8/PEM, because a format with structure invites the file to grow
// fields (an algorithm identifier, a key id) that would then have to be trusted;
// and because a seed is exactly 32 bytes with no ambiguity about what they mean.

use crate::digest::{decode_hex, encode_hex};
use anyhow::{anyhow, Context, Result};
use ed25519_dalek::SigningKey;
use std::fs;
use std::path::{Path, PathBuf};

/// An Ed25519 seed is 32 bytes.
pub const SEED_LEN: usize = 32;

/// Where a signing key lives when nobody says otherwise:
/// `~/.carbon/keys/plugin-signing.key` (`%USERPROFILE%` on Windows).
///
/// Outside every checkout, so the default path can never be a path `git add -A`
/// would pick up.
pub fn default_path() -> Result<PathBuf> {
    let home = std::env::var_os("CARBON_HOME")
        .or_else(|| std::env::var_os("HOME"))
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| {
            anyhow!("cannot find a home directory — pass --key with an explicit path")
        })?;
    Ok(Path::new(&home)
        .join(".carbon")
        .join("keys")
        .join("plugin-signing.key"))
}

/// Mint a new key from the OS CSPRNG.
///
/// `getrandom` is the OS's own entropy source (`BCryptGenRandom` on Windows,
/// `getrandom(2)` on Linux), not a userspace PRNG seeded from one — for a key
/// that will outlive every plugin signed with it, the difference matters.
pub fn generate() -> Result<SigningKey> {
    let mut seed = [0u8; SEED_LEN];
    getrandom::getrandom(&mut seed)
        .map_err(|e| anyhow!("the OS random source failed, refusing to invent a key: {e}"))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Write a key, refusing to clobber one that already exists.
///
/// Overwriting is the one mistake with no undo: every plugin already signed with
/// the old key becomes unverifiable, on every machine, at once. Deleting the
/// file first has to be a deliberate act.
pub fn write(path: &Path, key: &SigningKey) -> Result<()> {
    if path.exists() {
        return Err(anyhow!(
            "a signing key already exists at {} — refusing to overwrite it.\n  \
             Every plugin signed with that key would stop verifying. Move it \
             aside deliberately if you really mean to rotate.",
            path.display()
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("creating key directory {}", parent.display()))?;
    }

    let mut text = String::new();
    text.push_str("# Carbon plugin signing key (Ed25519 seed, hex).\n");
    text.push_str("# SECRET. Never commit this, never paste it, never copy it onto a build\n");
    text.push_str("# machine that runs untrusted code. Anyone holding it can sign a plugin\n");
    text.push_str("# that every Carbon app in the world will load.\n");
    text.push_str(&encode_hex(&key.to_bytes()));
    text.push('\n');
    fs::write(path, text).with_context(|| format!("writing key to {}", path.display()))?;

    restrict_permissions(path);
    Ok(())
}

/// Read a key file.
pub fn read(path: &Path) -> Result<SigningKey> {
    let text = fs::read_to_string(path).map_err(|e| {
        anyhow!(
            "cannot read signing key {} ({e}).\n  \
             Generate one with `carbon-plugin-sign keygen`, or point --key at \
             wherever yours is kept.",
            path.display()
        )
    })?;

    let seed_line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .ok_or_else(|| anyhow!("{} contains no key line", path.display()))?;

    let seed = decode_hex(seed_line, SEED_LEN).ok_or_else(|| {
        anyhow!(
            "{} is not a {SEED_LEN}-byte hex seed — expected {} hex characters, found {}",
            path.display(),
            SEED_LEN * 2,
            seed_line.len()
        )
    })?;
    let mut bytes = [0u8; SEED_LEN];
    bytes.copy_from_slice(&seed);
    Ok(SigningKey::from_bytes(&bytes))
}

/// Best-effort "owner only". Advisory — a key on a compromised machine is
/// compromised whatever its mode bits say — so a failure here is not fatal, but
/// leaving a private key world-readable when one syscall prevents it would be.
#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

/// Windows has no mode bits; the file inherits the user profile directory's ACL,
/// which is already owner-scoped for `%USERPROFILE%\.carbon`.
#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_key_reads_back_identical() {
        let dir = std::env::temp_dir().join(format!("carbon-trust-key-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("k.key");

        let key = generate().expect("OS RNG");
        write(&path, &key).expect("write");
        let back = read(&path).expect("read");
        assert_eq!(key.to_bytes(), back.to_bytes());
        assert_eq!(
            key.verifying_key().to_bytes(),
            back.verifying_key().to_bytes()
        );

        // And the second write is refused rather than silently rotating.
        assert!(write(&path, &generate().unwrap()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_does_not_return_the_same_key_twice() {
        assert_ne!(
            generate().unwrap().to_bytes(),
            generate().unwrap().to_bytes()
        );
    }
}
