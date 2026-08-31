// Downloading and verifying one platform's update artifact.
//
// Used to write a hardcoded `b"placeholder update file"` instead of fetching
// `platform_entry.url` at all — every "download" trivially passed its own
// sha256 check because the check ran against bytes it had just invented, not
// bytes that came from anywhere. Real now: an actual GET, streamed to a temp
// file and renamed into place (so a crash mid-download never leaves a
// half-written file the next run's existence check would trust), verified
// against BOTH the manifest's sha256 (integrity) and its Ed25519 signature
// (authenticity — see verify.rs for why sha256 alone was never enough).

use crate::manifest::{PlatformEntry, UpdaterManifest};
use crate::verify::verify_artifact_signature;
use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug)]
pub struct DownloadResult {
    pub path: PathBuf,
    pub size: u64,
}

/// Downloads and verifies one platform's artifact into `staging_dir`. If a
/// file is already there and passes both checks, the fetch is skipped — a
/// retried update shouldn't re-download what it already has; if it's there
/// but fails either check (a previous partial/corrupt attempt), it's
/// re-fetched rather than trusted.
pub fn download_update(
    manifest: &UpdaterManifest,
    platform: &str,
    staging_dir: &Path,
    pubkey_base64: &str,
) -> Result<DownloadResult> {
    let platform_entry = manifest
        .platforms
        .get(platform)
        .ok_or_else(|| anyhow!("Platform {platform} not found in manifest"))?;

    fs::create_dir_all(staging_dir)?;
    let version_dir = staging_dir.join(&manifest.version);
    fs::create_dir_all(&version_dir)?;

    let filename = platform_entry
        .url
        .split('/')
        .next_back()
        .unwrap_or("update.bin");
    let file_path = version_dir.join(filename);

    if !(file_path.exists() && verify_file(&file_path, platform_entry, pubkey_base64).is_ok()) {
        download_to(&platform_entry.url, &file_path)?;
        verify_file(&file_path, platform_entry, pubkey_base64)?;
    }

    let metadata = fs::metadata(&file_path)?;
    Ok(DownloadResult {
        path: file_path,
        size: metadata.len(),
    })
}

fn download_to(url: &str, dest: &Path) -> Result<()> {
    let response = reqwest::blocking::Client::builder()
        // Installers can be tens of MB; 30s (http_client.rs's manifest/
        // stop-list timeout) would false-positive on a slow connection.
        .timeout(Duration::from_secs(300))
        .build()
        .context("building HTTP client")?
        .get(url)
        .send()
        .with_context(|| format!("downloading {url}"))?
        .error_for_status()
        .with_context(|| format!("download of {url} failed"))?;
    let bytes = response
        .bytes()
        .with_context(|| format!("reading response body from {url}"))?;

    // Write beside the final path, then rename — an interrupted write lands
    // on `.part`, never on the name the existence check above trusts.
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, dest).with_context(|| format!("renaming into {}", dest.display()))?;
    Ok(())
}

fn verify_file(path: &Path, entry: &PlatformEntry, pubkey_base64: &str) -> Result<()> {
    let content = fs::read(path)?;

    let mut hasher = Sha256::new();
    hasher.update(&content);
    let hash = format!("{:x}", hasher.finalize());
    if hash != entry.sha256 {
        anyhow::bail!("SHA256 mismatch: expected {}, got {hash}", entry.sha256);
    }

    verify_artifact_signature(&content, &entry.signature, pubkey_base64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{KeyringEntry, PlatformEntry};
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use std::collections::HashMap;

    fn manifest_with(platform: &str, entry: PlatformEntry) -> UpdaterManifest {
        let mut platforms = HashMap::new();
        platforms.insert(platform.to_string(), entry);
        UpdaterManifest {
            version: "1.0.0".into(),
            pub_date: "2026-01-01".into(),
            notes: String::new(),
            channel: "stable".into(),
            min_version: None,
            rollout: 100,
            keyring: KeyringEntry {
                primary: String::new(),
                secondary: None,
                secondary_signed_by_primary: None,
                validity_window_days: 90,
            },
            platforms,
        }
    }

    #[test]
    fn refuses_when_the_requested_platform_is_absent() {
        let manifest = manifest_with(
            "x86_64-pc-windows-msvc",
            PlatformEntry {
                signature: String::new(),
                url: "https://example.com/x.exe".into(),
                sha256: String::new(),
            },
        );
        let dir = std::env::temp_dir().join(format!("carbon-updater-test-{}", std::process::id()));
        let err = download_update(&manifest, "aarch64-apple-darwin", &dir, "").unwrap_err();
        assert!(err.to_string().contains("not found in manifest"));
    }

    #[test]
    fn verify_file_rejects_a_sha256_mismatch_before_checking_the_signature() {
        let key = SigningKey::from_bytes(&[1u8; 32]);
        let pubkey =
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes());
        let dir =
            std::env::temp_dir().join(format!("carbon-updater-verify-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("artifact.bin");
        fs::write(&path, b"real content").unwrap();

        let sig =
            base64::engine::general_purpose::STANDARD.encode(key.sign(b"real content").to_bytes());
        let entry = PlatformEntry {
            signature: sig,
            url: "https://example.com/artifact.bin".into(),
            // Deliberately wrong digest — content is right, hash claim isn't.
            sha256: "0000000000000000000000000000000000000000000000000000000000000000".into(),
        };
        let err = verify_file(&path, &entry, &pubkey).unwrap_err();
        assert!(err.to_string().contains("SHA256 mismatch"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_file_accepts_matching_hash_and_signature() {
        let key = SigningKey::from_bytes(&[2u8; 32]);
        let pubkey =
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes());
        let dir =
            std::env::temp_dir().join(format!("carbon-updater-verify-ok-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("artifact.bin");
        let content = b"real installer bytes";
        fs::write(&path, content).unwrap();

        let sha256 = {
            let mut hasher = Sha256::new();
            hasher.update(content);
            format!("{:x}", hasher.finalize())
        };
        let sig = base64::engine::general_purpose::STANDARD.encode(key.sign(content).to_bytes());
        let entry = PlatformEntry {
            signature: sig,
            url: "https://example.com/artifact.bin".into(),
            sha256,
        };
        assert!(verify_file(&path, &entry, &pubkey).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn verify_file_rejects_a_hash_match_signed_by_the_wrong_key() {
        // The exact regression this whole module exists to close: a
        // consistent (artifact, sha256) pair is not enough on its own.
        let real_key = SigningKey::from_bytes(&[3u8; 32]);
        let attacker_key = SigningKey::from_bytes(&[4u8; 32]);
        let real_pubkey =
            base64::engine::general_purpose::STANDARD.encode(real_key.verifying_key().to_bytes());

        let dir = std::env::temp_dir().join(format!(
            "carbon-updater-verify-wrongkey-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("artifact.bin");
        let content = b"forged installer bytes";
        fs::write(&path, content).unwrap();

        let sha256 = {
            let mut hasher = Sha256::new();
            hasher.update(content);
            format!("{:x}", hasher.finalize())
        };
        // Signed by the attacker's key, not the one the app trusts.
        let forged_sig =
            base64::engine::general_purpose::STANDARD.encode(attacker_key.sign(content).to_bytes());
        let entry = PlatformEntry {
            signature: forged_sig,
            url: "https://example.com/artifact.bin".into(),
            sha256,
        };
        assert!(verify_file(&path, &entry, &real_pubkey).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
