use serde::{Deserialize, Serialize};
use anyhow::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YankedEntry {
    pub version: String,
    pub reason: Option<String>,
    pub yanked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopList {
    pub yanked: Vec<YankedEntry>,
    pub generated_at: String,
}

pub fn is_yanked<'a>(stop_list: &'a StopList, version: &str) -> Option<&'a YankedEntry> {
    stop_list
        .yanked
        .iter()
        .find(|entry| entry.version == version)
}

impl StopList {
    pub fn from_json(json: &str) -> Result<Self> {
        Ok(serde_json::from_str(json)?)
    }

    pub fn to_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(self)?)
    }
}
