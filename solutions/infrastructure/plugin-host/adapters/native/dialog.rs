// Native dialogs via rfd, backing the `dialog_*` ABI trampolines in
// abi/host_exports.rs (ABI 1.3). Previously a `carbon-os` adapter that
// installed `__cm_dialog_*` directly onto the JS context — moved here so
// dialogs go through the `dialog` plugin (products/carbon-sdk/dialog) like
// every other optional OS capability. The rfd usage and the `opts_json`
// shape (`{title, defaultPath, filters}`) are unchanged.
//
// `open_file_text`/`save_file_text` still do the picker AND the read/write
// in one call, on purpose: `fs`'s read/write stay scoped to the app's own
// data/config/cache/temp directories, so this remains the only way a raw
// path the user picked from their own Documents/Desktop/etc never has to
// cross into JS at all — the picker shows, the OS grants access to exactly
// what the user clicked, and the read or write happens right here.

use anyhow::Result;
use rfd::{FileDialog, MessageButtons, MessageDialog, MessageLevel};
use serde::Deserialize;

#[derive(Deserialize, Default)]
pub struct OpenOpts {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    #[serde(rename = "defaultPath")]
    default_path: Option<String>,
    /// `[{"name": "Images", "extensions": ["png","jpg"]}, ...]`
    #[serde(default)]
    filters: Vec<FilterOpt>,
}

#[derive(Deserialize, Default)]
struct FilterOpt {
    name: String,
    extensions: Vec<String>,
}

fn build_dialog(opts: &OpenOpts) -> FileDialog {
    let mut d = FileDialog::new();
    if let Some(t) = &opts.title {
        d = d.set_title(t);
    }
    if let Some(p) = &opts.default_path {
        d = d.set_directory(p);
    }
    for f in &opts.filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        d = d.add_filter(&f.name, &exts);
    }
    d
}

fn parse_opts(s: &str) -> OpenOpts {
    serde_json::from_str(s).unwrap_or_default()
}

pub fn open_file(opts_json: &str) -> Option<String> {
    build_dialog(&parse_opts(opts_json))
        .pick_file()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
}

pub fn open_files(opts_json: &str) -> Vec<String> {
    build_dialog(&parse_opts(opts_json))
        .pick_files()
        .map(|v| {
            v.into_iter()
                .filter_map(|p| p.to_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

pub fn open_dir(opts_json: &str) -> Option<String> {
    build_dialog(&parse_opts(opts_json))
        .pick_folder()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
}

pub fn save_file(opts_json: &str) -> Option<String> {
    build_dialog(&parse_opts(opts_json))
        .save_file()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
}

pub fn open_file_text(opts_json: &str) -> Result<Option<String>> {
    let Some(path) = build_dialog(&parse_opts(opts_json)).pick_file() else {
        return Ok(None);
    };
    Ok(Some(std::fs::read_to_string(&path)?))
}

pub fn save_file_text(opts_json: &str, content: &str) -> Result<bool> {
    let Some(path) = build_dialog(&parse_opts(opts_json)).save_file() else {
        return Ok(false);
    };
    std::fs::write(&path, content)?;
    Ok(true)
}

/// Message box with a single OK button. `level` is "info" / "warning" /
/// "error" — anything else maps to info.
pub fn message(title: &str, body: &str, level: &str) {
    let level = match level {
        "warning" | "warn" => MessageLevel::Warning,
        "error" => MessageLevel::Error,
        _ => MessageLevel::Info,
    };
    let _ = MessageDialog::new()
        .set_title(title)
        .set_description(body)
        .set_level(level)
        .set_buttons(MessageButtons::Ok)
        .show();
}

/// Yes/No prompt. Returns true if the user picked Yes.
pub fn confirm(title: &str, body: &str) -> bool {
    let result = MessageDialog::new()
        .set_title(title)
        .set_description(body)
        .set_level(MessageLevel::Info)
        .set_buttons(MessageButtons::YesNo)
        .show();
    matches!(result, rfd::MessageDialogResult::Yes)
}
