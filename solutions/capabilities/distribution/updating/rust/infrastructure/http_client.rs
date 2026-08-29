// Fetching the two small JSON documents the updater polls: the channel
// manifest and its stop list. Both live at the same base URL an app's
// `[updater].url` points at (see the S3 layout `@carbon/publishing` writes
// to: `<channel>/manifest.json` and `<channel>/yanked.json`, siblings) — a
// bare GET, no auth, no retry logic beyond what reqwest gives for free. The
// artifact download in downloader.rs is the other, larger fetch; kept
// separate because it streams to disk instead of buffering a whole response
// as a string.

use crate::manifest::UpdaterManifest;
use crate::stop_list::StopList;
use anyhow::{Context, Result};
use std::time::Duration;

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("carbon-updater/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("building HTTP client")
}

/// GETs `{base_url}/manifest.json` and returns both the raw text (what a
/// signature check must verify against — see verify.rs's own comment on why
/// that must be the literal fetched bytes) and the parsed manifest.
pub fn fetch_manifest(base_url: &str) -> Result<(String, UpdaterManifest)> {
    let url = format!("{}/manifest.json", base_url.trim_end_matches('/'));
    let text = client()?
        .get(&url)
        .send()
        .with_context(|| format!("fetching manifest from {url}"))?
        .error_for_status()
        .with_context(|| format!("manifest request to {url} failed"))?
        .text()
        .with_context(|| format!("reading manifest body from {url}"))?;
    let manifest: UpdaterManifest =
        serde_json::from_str(&text).with_context(|| format!("parsing manifest from {url}"))?;
    Ok((text, manifest))
}

/// GETs `{base_url}/manifest.sig` — the detached signature covering the
/// exact bytes `fetch_manifest` returned as its `.0`. Separate call, separate
/// object, same as @carbon/publishing writes them (two sibling uploads, not
/// one combined document) — verify.rs's verify_manifest_signature takes both.
pub fn fetch_manifest_sig(base_url: &str) -> Result<String> {
    let url = format!("{}/manifest.sig", base_url.trim_end_matches('/'));
    client()?
        .get(&url)
        .send()
        .with_context(|| format!("fetching manifest signature from {url}"))?
        .error_for_status()
        .with_context(|| format!("manifest signature request to {url} failed"))?
        .text()
        .with_context(|| format!("reading manifest signature body from {url}"))
}

/// GETs `{base_url}/yanked.json`. A missing stop list (404 — nothing has ever
/// been yanked on this channel) is NOT an error: it means an empty list, the
/// same "nothing here yet" the publishing side's fetchStopList treats as
/// empty rather than throwing.
pub fn fetch_stop_list(base_url: &str) -> Result<StopList> {
    let url = format!("{}/yanked.json", base_url.trim_end_matches('/'));
    let response = client()?
        .get(&url)
        .send()
        .with_context(|| format!("fetching stop list from {url}"))?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(StopList {
            yanked: Vec::new(),
            generated_at: String::new(),
        });
    }

    let text = response
        .error_for_status()
        .with_context(|| format!("stop list request to {url} failed"))?
        .text()
        .with_context(|| format!("reading stop list body from {url}"))?;
    StopList::from_json(&text).with_context(|| format!("parsing stop list from {url}"))
}
