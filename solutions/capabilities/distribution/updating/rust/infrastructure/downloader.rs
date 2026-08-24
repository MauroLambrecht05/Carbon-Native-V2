use crate::manifest::UpdaterManifest;
use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub struct DownloadResult {
    pub path: PathBuf,
    pub size: u64,
}

pub fn download_update(
    manifest: &UpdaterManifest,
    platform: &str,
    staging_dir: &Path,
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

    if file_path.exists() {
        verify_file(&file_path, &platform_entry.sha256)?;
        let metadata = fs::metadata(&file_path)?;
        return Ok(DownloadResult {
            path: file_path,
            size: metadata.len(),
        });
    }

    write_placeholder(&file_path)?;

    verify_file(&file_path, &platform_entry.sha256)?;

    let metadata = fs::metadata(&file_path)?;
    Ok(DownloadResult {
        path: file_path,
        size: metadata.len(),
    })
}

fn verify_file(path: &Path, expected_sha256: &str) -> Result<()> {
    let content = fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&content);
    let hash = format!("{:x}", hasher.finalize());

    if hash == expected_sha256 {
        Ok(())
    } else {
        Err(anyhow!(
            "SHA256 mismatch: expected {expected_sha256}, got {hash}"
        ))
    }
}

fn write_placeholder(path: &Path) -> Result<()> {
    let placeholder = b"placeholder update file";
    fs::write(path, placeholder)?;
    Ok(())
}
