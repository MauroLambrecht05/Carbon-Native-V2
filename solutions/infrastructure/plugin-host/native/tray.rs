// System tray icon via the `tray-icon` crate, backing the `tray_*` ABI
// trampolines in abi/host_exports.rs (ABI 1.5). Same tauri-apps
// ecosystem/event-delivery shape as global_shortcuts.rs.
//
// PNG-only icons, decoded to raw RGBA via `image` and handed to
// `Icon::from_rgba`, rather than `Icon::from_path` — the latter has a
// genuine per-platform format split (Windows' implementation calls
// Win32's `LoadImageW`, which requires a real `.ico` file; macOS/Linux
// accept other formats through their own native decoders). Decoding PNG
// ourselves once gives every platform the same input contract instead of
// documenting "ship a `.ico` on Windows, something else elsewhere."
//
// One tray icon per process — matches the OS-level expectation (a second
// `setup()` call is a no-op) and this plugin's own scope: `useTray` in
// `solutions/interface/plugins/tray.ts` is meant to be called once, high
// in an app, not per-component.
//
// THREAD CONSTRAINT (from the crate's own docs): the tray icon must be
// created on the same thread as the OS event loop (Windows/Linux) or the
// main thread (macOS) — same reasoning, and same `thread_local!` fix, as
// global_shortcuts.rs's `GlobalHotKeyManager`.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::cell::RefCell;
use std::sync::OnceLock;
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};

thread_local! {
    static TRAY: RefCell<Option<TrayIcon>> = const { RefCell::new(None) };
}

#[derive(Deserialize)]
struct MenuItemSpec {
    id: String,
    label: String,
}

/// `icon_path` is a PNG file, resolved by the caller (the Zig plugin, same
/// as fonts' `resolvePath`) before reaching here. `menu_items_json` is a
/// JSON array of `{id, label}` objects, or empty/`"[]"` for no menu.
pub fn setup(icon_path: &str, tooltip: &str, menu_items_json: &str) -> Result<()> {
    let already_set_up = TRAY.with(|cell| cell.borrow().is_some());
    if already_set_up {
        return Ok(());
    }

    let img = image::open(icon_path)?.into_rgba8();
    let (width, height) = img.dimensions();
    let icon = Icon::from_rgba(img.into_raw(), width, height)?;

    let mut builder = TrayIconBuilder::new().with_icon(icon);
    if !tooltip.is_empty() {
        builder = builder.with_tooltip(tooltip);
    }

    let items: Vec<MenuItemSpec> = if menu_items_json.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(menu_items_json).unwrap_or_default()
    };
    if !items.is_empty() {
        let menu = Menu::new();
        for item in &items {
            let menu_item = MenuItem::with_id(item.id.clone(), &item.label, true, None);
            menu.append(&menu_item).map_err(|e| anyhow!(e.to_string()))?;
        }
        builder = builder.with_menu(Box::new(menu));
    }

    let tray = builder.build()?;
    TRAY.with(|cell| *cell.borrow_mut() = Some(tray));

    ensure_listener_threads();
    Ok(())
}

/// One background thread per event source (tray click, menu selection) —
/// same shape as global_shortcuts.rs's single listener thread, just two of
/// them since tray-icon exposes two independent channels rather than one.
static LISTENERS_STARTED: OnceLock<()> = OnceLock::new();

fn ensure_listener_threads() {
    LISTENERS_STARTED.get_or_init(|| {
        std::thread::spawn(|| {
            let receiver = TrayIconEvent::receiver();
            while let Ok(event) = receiver.recv() {
                // Left-button release is "the user clicked the tray icon" —
                // Down would fire on press, before the OS has decided this
                // isn't the start of a drag; Up is what every tray-icon
                // convention (and this crate's own docs) treats as a click.
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    crate::host_exports::push_plugin_event("tray.click".to_string(), "{}".to_string());
                }
            }
        });
        std::thread::spawn(|| {
            let receiver = MenuEvent::receiver();
            while let Ok(event) = receiver.recv() {
                let id_json = serde_json::to_string(&event.id.0).unwrap_or_else(|_| "\"\"".to_string());
                crate::host_exports::push_plugin_event("tray.menu".to_string(), format!("{{\"id\":{id_json}}}"));
            }
        });
    });
}
