// Signing an artifact. Runs on Carbon's machine, holding Carbon's private key,
// and never on a user's.
//
// Step 6 of the Layer 3 pipeline: "The artifact that passed 1–5 gets signed
// with Carbon's own key, never the author's, in a separate step that never
// itself executes untrusted code." Nothing here loads, links, or runs the
// artifact — it is read as bytes and hashed. That is what makes this step safe
// to run on the same machine that holds the key.

use crate::digest::ContentHash;
use crate::signature::{signature_path, SIGNATURE_LEN};
use anyhow::{Context, Result};
use ed25519_dalek::{Signer, SigningKey};
use std::fs;
use std::path::{Path, PathBuf};

/// What signing produced, so a caller can report it without re-reading disk.
#[derive(Debug, Clone)]
pub struct SignedArtifact {
    /// The artifact that was signed.
    pub artifact: PathBuf,
    /// Where the detached signature was written.
    pub signature: PathBuf,
    /// The artifact's identity — the same value the revocation list names.
    pub content_hash: ContentHash,
}

/// Sign `artifact`'s bytes and write `<artifact>.sig` beside it.
///
/// Overwrites an existing `.sig`: re-signing after a rebuild is the normal
/// case, and a stale signature left in place would fail verification in a way
/// that looks like tampering.
pub fn sign_artifact(artifact: &Path, key: &SigningKey) -> Result<SignedArtifact> {
    let bytes = fs::read(artifact)
        .with_context(|| format!("reading artifact {}", artifact.display()))?;
    let content_hash = ContentHash::of(&bytes);
    let signature = sign_hash(&content_hash, key);

    let sig_path = signature_path(artifact);
    fs::write(&sig_path, signature)
        .with_context(|| format!("writing signature {}", sig_path.display()))?;

    Ok(SignedArtifact {
        artifact: artifact.to_path_buf(),
        signature: sig_path,
        content_hash,
    })
}

/// The signing operation itself: Ed25519 over the 32-byte digest.
///
/// The digest is the message, not the file — see the note in lib.rs. Kept
/// separate from the filesystem so the verification side's test can sign
/// without touching disk.
pub fn sign_hash(hash: &ContentHash, key: &SigningKey) -> [u8; SIGNATURE_LEN] {
    key.sign(hash.as_bytes()).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::verification::verify_bytes;

    fn test_key() -> SigningKey {
        // A fixed seed: this is a TEST key, and it never signs anything that
        // leaves the test process. Generating one here would make the test
        // depend on the OS RNG for no gain.
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn a_signature_this_module_produced_verifies() {
        let key = test_key();
        let public = key.verifying_key().to_bytes();
        let bytes = b"pretend this is a compiled plugin";
        let sig = sign_hash(&ContentHash::of(bytes), &key);
        assert!(verify_bytes(bytes, &sig, &public).is_ok());
    }

    #[test]
    fn signing_writes_a_sibling_sig_file() {
        let dir = std::env::temp_dir().join(format!(
            "carbon-trust-sign-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let dll = dir.join("fake_plugin.dll");
        fs::write(&dll, b"MZ...not really a dll").unwrap();

        let signed = sign_artifact(&dll, &test_key()).unwrap();
        assert_eq!(signed.signature, dir.join("fake_plugin.dll.sig"));
        assert_eq!(
            fs::read(&signed.signature).unwrap().len(),
            SIGNATURE_LEN,
            "a detached signature is exactly {SIGNATURE_LEN} bytes"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
