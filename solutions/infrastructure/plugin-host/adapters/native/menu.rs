// Native application menu bar via the `tray-icon` crate's re-exported
// `muda` (`tray_icon::menu`) — same dependency tray.rs already uses for its
// popup menu, no separate `muda` crate declared (see the doc comment on
// the `tray-icon` Cargo dependency for why). Backs the `menu_*` ABI
// trampolines in abi/host_exports.rs (ABI 1.7).
//
// PLATFORM: Windows-only for now (`Menu::init_for_hwnd`), like several
// other native modules here (terminal's ConPTY, deep-link's registry
// self-registration) — macOS needs `init_for_nsapp`, Linux/gtk needs
// `init_for_gtk_window`, both real, separate implementations rather than
// guessed at. `setup` returns an error on non-Windows until one of those
// lands.
//
// MENU-CLICK EVENT DELIVERY: does NOT listen to `MenuEvent::receiver()`
// itself — that channel is process-wide and shared with tray.rs's own
// popup menu, so exactly one thread drains it. See menu_events.rs for why
// and how dispatch is routed back here.
//
// THREAD CONSTRAINT: like tray.rs and global_shortcuts.rs, `init_for_hwnd`
// must run on the same thread that owns the window (the JS/event-loop
// thread) — true here by construction, since `menu_setup` is called
// synchronously from a plugin's JS-thread-only `set_global_function`
// callback, same as tray_setup.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::cell::RefCell;
use std::str::FromStr;
use tray_icon::menu::accelerator::Accelerator;
use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

thread_local! {
    static ACTIVE_MENU: RefCell<Option<Menu>> = const { RefCell::new(None) };
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ItemSpec {
    Separator {
        #[allow(dead_code)]
        separator: bool,
    },
    Item {
        id: String,
        label: String,
        accelerator: Option<String>,
    },
}

#[derive(Deserialize)]
struct TopMenuSpec {
    label: String,
    items: Vec<ItemSpec>,
}

/// `hwnd` is the raw Win32 window handle (see `HostCarbonApp::raw_window_handle`,
/// populated at startup by mini.rs from `WindowExtWindows::hwnd()`).
/// `menu_json` is the top-level array documented on `menu_setup` in
/// carbon_plugin.h.
pub fn setup(hwnd: isize, menu_json: &str) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (hwnd, menu_json);
        return Err(anyhow!(
            "native menu bar not yet implemented on this platform"
        ));
    }

    #[cfg(target_os = "windows")]
    {
        if hwnd == 0 {
            return Err(anyhow!("no window handle available yet"));
        }
        let specs: Vec<TopMenuSpec> = serde_json::from_str(menu_json)?;

        let menu = Menu::new();
        let mut ids: Vec<String> = Vec::new();
        for top in &specs {
            let submenu = Submenu::new(&top.label, true);
            for item in &top.items {
                match item {
                    ItemSpec::Separator { .. } => {
                        submenu
                            .append(&PredefinedMenuItem::separator())
                            .map_err(|e| anyhow!(e.to_string()))?;
                    }
                    ItemSpec::Item {
                        id,
                        label,
                        accelerator,
                    } => {
                        let accel = match accelerator {
                            Some(s) => {
                                Some(Accelerator::from_str(s).map_err(|e| anyhow!(e.to_string()))?)
                            }
                            None => None,
                        };
                        let menu_item = MenuItem::with_id(id.clone(), label, true, accel);
                        submenu
                            .append(&menu_item)
                            .map_err(|e| anyhow!(e.to_string()))?;
                        ids.push(id.clone());
                    }
                }
            }
            menu.append(&submenu).map_err(|e| anyhow!(e.to_string()))?;
        }

        // SAFETY: `hwnd` is a live window handle for the entire process
        // lifetime (it's the app's single main window), and this runs on
        // the JS/event-loop thread per this file's own THREAD CONSTRAINT
        // note.
        unsafe {
            menu.init_for_hwnd(hwnd)
                .map_err(|e| anyhow!(e.to_string()))?;
        }
        // Win32's SetMenu (which init_for_hwnd calls internally) replaces
        // whatever menu was already attached — no explicit remove needed
        // before re-applying, e.g. after HMR re-runs carbon_plugin_after_reload.
        ACTIVE_MENU.with(|cell| *cell.borrow_mut() = Some(menu));

        crate::menu_events::set_window_menu_ids(ids);
        crate::menu_events::ensure_started();
        Ok(())
    }
}
