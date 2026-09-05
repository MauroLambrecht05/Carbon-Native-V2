// The ONE listener thread for `tray_icon::menu::MenuEvent::receiver()`,
// shared between tray.rs (the tray icon's own popup menu) and menu.rs (the
// native window menu bar) — both build their menus from the SAME
// `tray-icon`/muda crate, and muda's `MenuEvent::receiver()` is a single
// process-wide channel (`static MENU_CHANNEL`, not per-menu). Two
// independent listener threads each calling `.recv()` on it would be
// competing consumers: any given click goes to whichever thread happens to
// be the one that `.recv()`s it, not to both — so a naive "tray.rs spawns
// its own, menu.rs spawns its own" design randomly drops window-menu
// clicks, tray-menu clicks, or both, whenever both plugins are loaded
// (the common case — carbon-desktop bundles them together).
//
// Fix: exactly one thread drains the channel, dispatching by membership in
// `WINDOW_MENU_IDS` (populated by menu.rs's own `setup()`) — an id that
// menu.rs registered fires `push_event("menu.click", …)`; anything else is
// assumed to be a tray context-menu click and fires `push_event("tray.menu",
// …)`, preserving tray.rs's exact previous behavior for apps that only use
// the tray plugin. Compiled whenever either menu-click source exists.

use std::sync::{Mutex, OnceLock};
use tray_icon::menu::MenuEvent;

static WINDOW_MENU_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Replaces the set of ids the native window menu bar owns — called once
/// per `menu::setup()`, including re-applications after HMR. A `Vec` (not
/// `HashSet`) because menus are small (tens of items, not thousands) and
/// this only reads via `.contains()` on the listener thread's hot path;
/// simplicity wins over an unneeded hash allocation.
#[cfg(feature = "menu")]
pub fn set_window_menu_ids(ids: Vec<String>) {
    *WINDOW_MENU_IDS.lock().unwrap_or_else(|e| e.into_inner()) = ids;
}

fn is_window_menu_id(id: &str) -> bool {
    WINDOW_MENU_IDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|i| i == id)
}

static LISTENER_STARTED: OnceLock<()> = OnceLock::new();

/// Starts the shared listener thread if it isn't already running. Safe to
/// call from both tray.rs and menu.rs, any number of times — the actual
/// spawn happens at most once per process.
pub fn ensure_started() {
    LISTENER_STARTED.get_or_init(|| {
        std::thread::spawn(|| {
            let receiver = MenuEvent::receiver();
            while let Ok(event) = receiver.recv() {
                let id = event.id.0;
                let id_json = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".to_string());
                let event_name = if is_window_menu_id(&id) { "menu.click" } else { "tray.menu" };
                crate::host_exports::push_plugin_event(
                    event_name.to_string(),
                    format!("{{\"id\":{id_json}}}"),
                );
            }
        });
    });
}
