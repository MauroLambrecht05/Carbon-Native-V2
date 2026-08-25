// Verifying an artifact. Runs on every user's machine, on every launch, before
// the first byte of plugin code executes.
//
// Step 7 of the Layer 3 pipeline: "an unsigned or wrong-signer `.dll` in
// `plugins/` does not load, regardless of how it got there."
//
// ── EVERY FAILURE IS AN Err, NEVER A PANIC ──────────────────────────────────
// The input to this module is, by assumption, attacker-controlled: a `.dll` and
// a `.sig` that someone dropped into a directory. A panic here aborts the app
// (and under `panic = "abort"` in some profiles, does so unrecoverably), which
// turns "a malformed signature file" into a denial of service. So there is no
// unwrap, no slice-index, and no length assumption on this path — a truncated
// `.sig`, an empty one, a directory where a file was expected, and a 4 GB one
// all come back as an ordinary error the loader logs and skips.

use crate::digest::ContentHash;
use crate::signature::{parse_detached, signature_path, SIGNATURE_LEN};
use anyhow::{anyhow, Context, Result};
use ed25519_dalek::{Signature, VerifyingKey};
use std::fs;
use std::path::Path;

/// An Ed25519 public key is 32 bytes. Callers embed one as a constant.
pub const PUBLIC_KEY_LEN: usize = 32;

/// Verify `artifact` against the detached `<artifact>.sig` beside it.
///
/// On success, returns the artifact's content hash — which the caller needs
/// anyway for the revocation check, so verifying does not make it read and hash
/// the file twice.
///
/// Refuses when the signature file is missing, unreadable, not exactly
/// [`SIGNATURE_LEN`] bytes, or does not verify against `public_key`.
pub fn verify_artifact(artifact: &Path, public_key: &[u8; PUBLIC_KEY_LEN]) -> Result<ContentHash> {
    let bytes = fs::read(artifact)
        .with_context(|| format!("reading plugin {}", artifact.display()))?;

    let sig_path = signature_path(artifact);
    let sig_bytes = fs::read(&sig_path).map_err(|e| {
        anyhow!(
            "no valid signature for {}: cannot read {} ({e}).\n  \
             Carbon plugins are signed by Carbon; an unsigned plugin is refused \
             whatever put it in this directory.\n  \
             If you built this plugin yourself, sign it with `carbon-plugin-sign \
             sign {}`.",
            artifact.display(),
            sig_path.display(),
            artifact.display(),
        )
    })?;

    let signature = parse_detached(&sig_bytes)
        .with_context(|| format!("signature file {}", sig_path.display()))?;

    verify_bytes(&bytes, &signature, public_key).map_err(|e| {
        anyhow!(
            "signature check FAILED for {}: {e}\n  \
             The plugin or its signature has been modified since it was signed, \
             or it was signed by a key that is not Carbon's.",
            artifact.display(),
        )
    })
}

/// The verification decision itself, over bytes already in memory.
///
/// Split out from the filesystem so it is testable without one, and so the
/// signer's own round-trip test can call the real check rather than a copy.
pub fn verify_bytes(
    content: &[u8],
    signature: &[u8; SIGNATURE_LEN],
    public_key: &[u8; PUBLIC_KEY_LEN],
) -> Result<ContentHash> {
    let key = VerifyingKey::from_bytes(public_key)
        .map_err(|e| anyhow!("embedded public key is not a valid Ed25519 point: {e}"))?;
    let hash = ContentHash::of(content);
    let sig = Signature::from_bytes(signature);

    // `verify_strict`, not `verify`: it additionally rejects signatures made
    // with a small-order or torsion component key, which is what closes the
    // signature-malleability hole (one signature verifying under more than one
    // public key) that ed25519-dalek 1.x's plain `verify` had. Strict is the
    // right default whenever the key is fixed and the signature is the
    // attacker-supplied half, which is exactly this situation.
    key.verify_strict(hash.as_bytes(), &sig)
        .map_err(|e| anyhow!("Ed25519 verification rejected the signature: {e}"))?;

    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::sign_hash;
    use ed25519_dalek::SigningKey;

    fn keys() -> (SigningKey, [u8; PUBLIC_KEY_LEN]) {
        let k = SigningKey::from_bytes(&[42u8; 32]);
        let p = k.verifying_key().to_bytes();
        (k, p)
    }

    #[test]
    fn accepts_an_untouched_artifact() {
        let (key, public) = keys();
        let content = b"compiled plugin bytes";
        let sig = sign_hash(&ContentHash::of(content), &key);
        let hash = verify_bytes(content, &sig, &public).expect("should verify");
        assert_eq!(hash, ContentHash::of(content));
    }

    #[test]
    fn refuses_a_single_flipped_content_byte() {
        let (key, public) = keys();
        let mut content = b"compiled plugin bytes".to_vec();
        let sig = sign_hash(&ContentHash::of(&content), &key);
        content[3] ^= 0x01;
        assert!(verify_bytes(&content, &sig, &public).is_err());
    }

    #[test]
    fn refuses_a_single_flipped_signature_byte() {
        let (key, public) = keys();
        let content = b"compiled plugin bytes";
        let mut sig = sign_hash(&ContentHash::of(content), &key);
        sig[0] ^= 0x01;
        assert!(verify_bytes(content, &sig, &public).is_err());
    }

    #[test]
    fn refuses_a_signature_from_the_wrong_key() {
        let (_, public) = keys();
        let attacker = SigningKey::from_bytes(&[99u8; 32]);
        let content = b"compiled plugin bytes";
        let sig = sign_hash(&ContentHash::of(content), &attacker);
        assert!(verify_bytes(content, &sig, &public).is_err());
    }

    #[test]
    fn a_missing_sig_file_is_an_error_not_a_panic() {
        let (_, public) = keys();
        let missing = std::env::temp_dir().join("carbon-trust-no-such-plugin.dll");
        let _ = fs::remove_file(&missing);
        let err = verify_artifact(&missing, &public).unwrap_err().to_string();
        assert!(!err.is_empty());
    }

    #[test]
    fn a_truncated_sig_file_is_malformed_not_a_panic() {
        let dir = std::env::temp_dir().join(format!("carbon-trust-verify-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dll = dir.join("truncated.dll");
        fs::write(&dll, b"content").unwrap();
        fs::write(signature_path(&dll), [0u8; 10]).unwrap();

        let (_, public) = keys();
        let err = verify_artifact(&dll, &public).unwrap_err();
        assert!(
            format!("{err:#}").contains("malformed signature"),
            "wrong error: {err:#}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
