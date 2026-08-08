use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotState {
    pub active_slot: String,
    pub previous_slot: Option<String>,
    pub in_progress_count: u32,
    pub last_successful_version: Option<String>,
    pub installation_id: String,
}

impl SlotState {
    pub fn load(install_dir: &Path) -> Result<Self> {
        let current_path = install_dir.join("current.toml");
        if current_path.exists() {
            let content = fs::read_to_string(&current_path)?;
            Ok(toml::from_str(&content)?)
        } else {
            Ok(SlotState {
                active_slot: "1.0.0".to_string(),
                previous_slot: None,
                in_progress_count: 0,
                last_successful_version: Some("1.0.0".to_string()),
                installation_id: Uuid::new_v4().to_string(),
            })
        }
    }

    pub fn save(&self, install_dir: &Path) -> Result<()> {
        let current_path = install_dir.join("current.toml");
        fs::create_dir_all(install_dir)?;
        let content = toml::to_string_pretty(self)?;
        fs::write(current_path, content)?;
        Ok(())
    }

    pub fn mark_launch_started(&mut self, install_dir: &Path) -> Result<()> {
        self.in_progress_count += 1;
        self.save(install_dir)?;
        Ok(())
    }

    pub fn mark_first_frame(&mut self, install_dir: &Path) -> Result<()> {
        self.last_successful_version = Some(self.active_slot.clone());
        self.in_progress_count = 0;
        self.save(install_dir)?;
        Ok(())
    }

    pub fn rollback(&mut self, install_dir: &Path) -> Result<()> {
        if let Some(prev) = &self.previous_slot {
            std::mem::swap(&mut self.active_slot, &mut self.previous_slot.as_mut().unwrap());
            self.in_progress_count = 0;
        }
        self.save(install_dir)?;
        Ok(())
    }

    pub fn needs_rollback(&self, crash_threshold: u32) -> bool {
        self.in_progress_count >= crash_threshold
    }
}
