use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyringEntry {
    pub primary: String,
    pub secondary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary_signed_by_primary: Option<String>,
    pub validity_window_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformEntry {
    pub signature: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdaterManifest {
    pub version: String,
    pub pub_date: String,
    pub notes: String,
    pub channel: String,
    pub min_version: Option<String>,
    pub rollout: u8,
    pub keyring: KeyringEntry,
    pub platforms: HashMap<String, PlatformEntry>,
}
