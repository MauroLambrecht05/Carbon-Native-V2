// Native dialogs via rfd. Open-file / open-files / open-dir / save-file
// + simple message box and confirm. Filters and titles are passed as a
// single JSON-encoded options string (`{title, defaultPath, filters}`)
// so the host-import signature stays boring.
//
// rfd dispatches to the OS-native dialog: IFileDialog on Windows,
// NSOpenPanel/NSSavePanel on macOS, GTK or xdg-portal on Linux.

use anyhow::Result;
use rfd::{FileDialog, MessageButtons, MessageDialog, MessageLevel};
use rquickjs::{Context as JsContext, Ctx, Exception, Function};
use serde::Deserialize;

/// Throw a real JS Error with `e`'s message — same reasoning as fs.rs's
/// `throw`: `Exception::throw_message` avoids the "Error converting from js
/// ..." prefix that `Error::new_from_js_message` adds for its own, different
/// purpose (JS->Rust type-conversion diagnostics).
fn throw<E: std::fmt::Display>(ctx: &Ctx<'_>, e: E) -> rquickjs::Error {
    Exception::throw_message(ctx, &e.to_string())
}

#[derive(Deserialize, Default)]
struct OpenOpts {
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

pub fn register(js_ctx: &JsContext) -> Result<()> {
    js_ctx.with(|ctx| -> Result<()> {
        let g = ctx.globals();

        g.set(
            "__cm_dialog_open_file",
            Function::new(ctx.clone(), |opts_json: String| -> Option<String> {
                let opts = parse_opts(&opts_json);
                build_dialog(&opts)
                    .pick_file()
                    .and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        g.set(
            "__cm_dialog_open_files",
            Function::new(ctx.clone(), |opts_json: String| -> Vec<String> {
                let opts = parse_opts(&opts_json);
                build_dialog(&opts)
                    .pick_files()
                    .map(|v| {
                        v.into_iter()
                            .filter_map(|p| p.to_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default()
            })?,
        )?;

        g.set(
            "__cm_dialog_open_dir",
            Function::new(ctx.clone(), |opts_json: String| -> Option<String> {
                let opts = parse_opts(&opts_json);
                build_dialog(&opts)
                    .pick_folder()
                    .and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        g.set(
            "__cm_dialog_save_file",
            Function::new(ctx.clone(), |opts_json: String| -> Option<String> {
                let opts = parse_opts(&opts_json);
                build_dialog(&opts)
                    .save_file()
                    .and_then(|p| p.to_str().map(|s| s.to_string()))
            })?,
        )?;

        // ─── Read/write in the same call as the picker ─────────────────
        // `fs.rs`'s read/write are scoped to the app's own data/config/
        // cache/temp directories — they refuse anything a user picked from
        // their own Documents, Desktop, etc. These two exist so a raw path
        // to a user-chosen file never has to cross into JS at all: the
        // picker shows, the OS grants access to exactly the file/location
        // the user clicked, and the read or write happens right here, in
        // the same host-import call. JS gets content in, or a success flag
        // out — never a path it could later hand to something else.
        g.set(
            "__cm_dialog_open_file_text",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, opts_json: String| -> rquickjs::Result<Option<String>> {
                    let opts = parse_opts(&opts_json);
                    let Some(path) = build_dialog(&opts).pick_file() else {
                        return Ok(None);
                    };
                    std::fs::read_to_string(&path)
                        .map(Some)
                        .map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        g.set(
            "__cm_dialog_save_file_text",
            Function::new(
                ctx.clone(),
                |ctx: Ctx<'_>, opts_json: String, content: String| -> rquickjs::Result<bool> {
                    let opts = parse_opts(&opts_json);
                    let Some(path) = build_dialog(&opts).save_file() else {
                        return Ok(false);
                    };
                    std::fs::write(&path, content)
                        .map(|_| true)
                        .map_err(|e| throw(&ctx, e))
                },
            )?,
        )?;

        // Message box with a single OK button. `level` is "info" /
        // "warning" / "error" — anything else maps to info.
        g.set(
            "__cm_dialog_message",
            Function::new(ctx.clone(), |title: String, body: String, level: String| {
                let level = match level.as_str() {
                    "warning" | "warn" => MessageLevel::Warning,
                    "error" => MessageLevel::Error,
                    _ => MessageLevel::Info,
                };
                let _ = MessageDialog::new()
                    .set_title(&title)
                    .set_description(&body)
                    .set_level(level)
                    .set_buttons(MessageButtons::Ok)
                    .show();
            })?,
        )?;

        // Yes/No prompt. Returns true if the user picked Yes.
        g.set(
            "__cm_dialog_confirm",
            Function::new(ctx.clone(), |title: String, body: String| -> bool {
                let result = MessageDialog::new()
                    .set_title(&title)
                    .set_description(&body)
                    .set_level(MessageLevel::Info)
                    .set_buttons(MessageButtons::YesNo)
                    .show();
                matches!(result, rfd::MessageDialogResult::Yes)
            })?,
        )?;

        Ok(())
    })?;
    Ok(())
}
