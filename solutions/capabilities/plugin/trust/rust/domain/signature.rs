// The detached-signature file: where it lives and what is in it.
//
// Signer and loader both go through this module, so the two halves of the
// agreement cannot be written down twice and drift.

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};

/// An Ed25519 signature is 64 bytes: R (32) ‖ s (32).
pub const SIGNATURE_LEN: usize = 64;

/// The extension appended — not replaced — so `plugin.dll` → `plugin.dll.sig`.
///
/// Appended rather than substituted on purpose: `.so`, `.dylib` and `.dll` all
/// have to work, and a scheme that swapped the extension would collide between
/// `plugin.dll` and a hypothetical `plugin.so` sitting in the same directory.
pub const SIGNATURE_EXTENSION: &str = "sig";

/// `plugin.dll` → `plugin.dll.sig`.
pub fn signature_path(artifact: &Path) -> PathBuf {
    let mut name = artifact.as_os_str().to_os_string();
    name.push(".");
    name.push(SIGNATURE_EXTENSION);
    PathBuf::from(name)
}

/// The `.sig` file's contents are the raw 64 signature bytes and nothing else —
/// no header, no armor, no version byte.
///
/// Deliberately not a self-describing container: every field a container would
/// carry (algorithm, key id, hash of the payload) is a field an attacker gets
/// to choose. There is exactly one algorithm and exactly one signer, both fixed
/// in code, so a file that is not 64 bytes is simply not a signature.
pub fn parse_detached(bytes: &[u8]) -> Result<[u8; SIGNATURE_LEN]> {
    if bytes.len() != SIGNATURE_LEN {
        return Err(anyhow!(
            "malformed signature: expected exactly {SIGNATURE_LEN} bytes, found {}",
            bytes.len()
        ));
    }
    let mut out = [0u8; SIGNATURE_LEN];
    out.copy_from_slice(bytes);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sig_path_appends_rather_than_replaces() {
        assert_eq!(
            signature_path(Path::new("plugins/carbon_hotkey.dll")),
            PathBuf::from("plugins/carbon_hotkey.dll.sig")
        );
        assert_eq!(
            signature_path(Path::new("/opt/app/libcarbon_hotkey.so")),
            PathBuf::from("/opt/app/libcarbon_hotkey.so.sig")
        );
    }

    #[test]
    fn wrong_length_is_malformed_not_a_panic() {
        assert!(parse_detached(&[]).is_err());
        assert!(parse_detached(&[0u8; 63]).is_err());
        assert!(parse_detached(&[0u8; 65]).is_err());
        assert!(parse_detached(&[0u8; SIGNATURE_LEN]).is_ok());
    }
}
