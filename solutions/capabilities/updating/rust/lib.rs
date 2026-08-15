// ── Layout ──────────────────────────────────────────────────────────────────
// The same three layers as this capability's TypeScript half, because it is the
// same capability: the CLI drives one at release time, the runtime links the
// other so an installed app can update itself. They must agree about the
// on-disk state file, and mirroring the structure is what makes a discrepancy
// visible rather than buried.
//
//   domain/          the state machine and the rules — no I/O
//   application/     applying an update, rolling one back
//   infrastructure/  fetching an artifact over the network
//
// `#[path]` keeps the module names, so every call site is unchanged.
#[path = "domain/state.rs"]
pub mod state;
#[path = "domain/rollout.rs"]
pub mod rollout;
#[path = "domain/stop_list.rs"]
pub mod stop_list;
#[path = "domain/manifest.rs"]
pub mod manifest;

#[path = "application/apply.rs"]
pub mod apply;
#[path = "application/rollback.rs"]
pub mod rollback;

#[path = "infrastructure/downloader.rs"]
pub mod downloader;

pub use manifest::UpdaterManifest;
pub use rollout::in_rollout;
pub use state::SlotState;
pub use stop_list::StopList;

pub type Result<T> = anyhow::Result<T>;

pub struct UpdaterConfig {
    pub install_dir: std::path::PathBuf,
    pub manifest_url: String,
    pub stop_list_url: String,
    pub pubkey_base64: String,
}
