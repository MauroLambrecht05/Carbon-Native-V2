// Global (OS-wide) keyboard shortcuts via the `global-hotkey` crate,
// backing the `global_shortcut_*` ABI trampolines in abi/host_exports.rs
// (ABI 1.4). Cross-platform (Windows/macOS/Linux-X11) rather than the
// hand-rolled Win32-only RegisterHotKey approach the earlier
// `labs/examples/pulse/plugins/carbon-hotkey` prototype used — this backs
// a real `products/carbon-sdk/global-shortcuts` plugin, so it needs to
// accept an arbitrary, runtime-parsed accelerator string ("Ctrl+Alt+P"),
// not one hotkey compiled in.
//
// PLATFORM CONSTRAINT (from the crate's own docs): the manager must be
// created on the same thread as the OS event loop (Windows needs a win32
// event loop on that thread; macOS requires the main thread) — and,
// consistent with that, `GlobalHotKeyManager` holds a raw platform handle
// that isn't `Send`. `register`/`unregister` below only ever run on the JS
// thread — which, in this runtime, IS the same thread tao's event loop
// runs on (see run_loop.rs) — so a `thread_local!` (not a process-wide
// `Mutex<Option<...>>`, which would need `GlobalHotKeyManager: Send`) is
// both what the type system requires and what the platform actually
// needs. Same reasoning as `TEXT_ENGINE` in this crate's abi/host_exports.rs.

use anyhow::{anyhow, Result};
use global_hotkey::{hotkey::HotKey, GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use std::cell::RefCell;
use std::str::FromStr;
use std::sync::OnceLock;

thread_local! {
    static MANAGER: RefCell<Option<GlobalHotKeyManager>> =
        RefCell::new(GlobalHotKeyManager::new().ok());
}

/// Registers `accelerator` and returns its id (see the ABI header's note
/// on `global_shortcut_register` for the id's determinism/purpose).
pub fn register(accelerator: &str) -> Result<u32> {
    let hotkey = HotKey::from_str(accelerator).map_err(|e| anyhow!(e.to_string()))?;
    MANAGER.with(|cell| {
        let borrow = cell.borrow();
        let mgr = borrow
            .as_ref()
            .ok_or_else(|| anyhow!("global hotkey manager unavailable on this platform"))?;
        mgr.register(hotkey)?;
        Ok::<(), anyhow::Error>(())
    })?;
    ensure_listener_thread();
    Ok(hotkey.id())
}

pub fn unregister(accelerator: &str) -> Result<()> {
    let hotkey = HotKey::from_str(accelerator).map_err(|e| anyhow!(e.to_string()))?;
    MANAGER.with(|cell| {
        let borrow = cell.borrow();
        let mgr = borrow
            .as_ref()
            .ok_or_else(|| anyhow!("global hotkey manager unavailable on this platform"))?;
        mgr.unregister(hotkey)?;
        Ok(())
    })
}

/// One process-wide background thread, started lazily on the first
/// registration — mirrors carbon-hotkey's own thread-per-listener pattern,
/// just against the crate's cross-platform event channel instead of a raw
/// Win32 message queue. Delivers every PRESSED event (not RELEASED — an
/// app registering a shortcut wants "the user pressed it", not a
/// press/release pair to reconcile) to JS via the existing `push_event`
/// mechanism.
static LISTENER_STARTED: OnceLock<()> = OnceLock::new();

fn ensure_listener_thread() {
    LISTENER_STARTED.get_or_init(|| {
        std::thread::spawn(|| {
            let receiver = GlobalHotKeyEvent::receiver();
            while let Ok(event) = receiver.recv() {
                if event.state() == HotKeyState::Pressed {
                    let payload = format!("{{\"id\":{}}}", event.id());
                    crate::host_exports::push_plugin_event("global-shortcut.fired".to_string(), payload);
                }
            }
        });
    });
}
