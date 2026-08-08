pub mod state;
pub mod rollback;
pub mod manifest;
pub mod stop_list;
pub mod downloader;
pub mod apply;
pub mod rollout;

pub use state::SlotState;
pub use rollout::in_rollout;
pub use manifest::UpdaterManifest;
pub use stop_list::StopList;

pub type Result<T> = anyhow::Result<T>;

pub struct UpdaterConfig {
    pub install_dir: std::path::PathBuf,
    pub manifest_url: String,
    pub stop_list_url: String,
    pub pubkey_base64: String,
}
