// The native OS share sheet via WinRT's DataTransferManager — backs the
// `share_content` ABI trampoline in abi/host_exports.rs (ABI 1.19).
//
// WINRT FROM A WIN32 DESKTOP APP: DataTransferManager has no per-window
// constructor of its own — a desktop app reaches it through
// `IDataTransferManagerInterop`, a classic COM interop interface
// (verified directly against the downloaded windows-0.58.0 source: it
// lives under `Windows::Win32::UI::Shell`, NOT the WinRT
// `ApplicationModel::DataTransfer` namespace its own return types come
// from — an interop seam, not a naming mistake). `GetForWindow` ties a
// manager instance to a specific HWND; `ShowShareUIForWindow` opens the
// flyout for it.
//
// WHY NO DEDICATED THREAD, UNLIKE biometrics.rs: `GetForWindow` and
// `ShowShareUIForWindow` are both plain synchronous calls, not
// `IAsyncOperation`s awaited with a blocking wait — there's no
// non-message-pumping `.get()` in this path at all. The `DataRequested`
// callback that fires later (when the user actually opens the flyout) is
// delivered through the same window-message pump already driving the
// calling (JS/event-loop) thread's own window, the same reentrancy-safe
// arrangement taskbar.rs's `SetProgressState`/`SetOverlayIcon` and
// menu.rs's `Menu::init_for_hwnd` already rely on. Safe to call directly
// on that thread.
//
// WHY THE MANAGER IS CACHED PER-HWND, NOT RE-FETCHED EVERY CALL: nothing
// in the crate's own binding source confirms whether the OS keeps a
// share registration alive independent of the `DataTransferManager`
// Rust value's own COM refcount — the conservative, verifiable-by-
// construction choice is to keep the SAME manager (and its ONE
// registered `DataRequested` handler) alive for as long as the window
// does, exactly like taskbar.rs's `ITaskbarList3` is cached rather than
// re-created per call. The handler is registered exactly once per HWND;
// each `share()` call only updates a thread_local "next payload" slot
// the handler reads and clears when it actually fires — avoiding both
// the manager-lifetime question above and re-registering (and
// potentially stacking up) a fresh handler on every call.
//
// PLATFORM: Windows-only. Sharing files (needs a native IStorageItem
// wrapper around an app-owned path) is NOT covered here — a separate,
// larger piece of work. macOS (NSSharingServicePicker) and Linux (no
// OS-native equivalent) are NOT covered here either.

use anyhow::Result;

#[cfg(target_os = "windows")]
struct SharePayload {
    title: String,
    text: String,
    url: String,
}

#[cfg(target_os = "windows")]
thread_local! {
    static COM_READY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static MANAGERS: std::cell::RefCell<std::collections::HashMap<isize, windows::ApplicationModel::DataTransfer::DataTransferManager>> =
        std::cell::RefCell::new(std::collections::HashMap::new());
    static PENDING: std::cell::RefCell<Option<SharePayload>> = const { std::cell::RefCell::new(None) };
}

#[cfg(target_os = "windows")]
fn ensure_com_initialized() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    COM_READY.with(|ready| {
        if !ready.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ready.set(true);
        }
    });
}

#[cfg(target_os = "windows")]
fn ensure_manager(
    hwnd: isize,
) -> Result<windows::ApplicationModel::DataTransfer::DataTransferManager> {
    use windows::core::HSTRING;
    use windows::ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager};
    use windows::Foundation::TypedEventHandler;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;

    ensure_com_initialized();
    MANAGERS.with(|cell| {
        let mut map = cell.borrow_mut();
        if let Some(existing) = map.get(&hwnd) {
            return Ok(existing.clone());
        }

        let interop: IDataTransferManagerInterop =
            windows::core::factory::<DataTransferManager, IDataTransferManagerInterop>().map_err(
                |e| anyhow::anyhow!("activating IDataTransferManagerInterop failed: {e}"),
            )?;
        let win = HWND(hwnd as *mut core::ffi::c_void);
        let manager: DataTransferManager = unsafe {
            interop.GetForWindow(win).map_err(|e| {
                anyhow::anyhow!("IDataTransferManagerInterop::GetForWindow failed: {e}")
            })?
        };

        manager
            .DataRequested(&TypedEventHandler::new(
                move |_sender: &Option<DataTransferManager>,
                      args: &Option<DataRequestedEventArgs>|
                      -> windows::core::Result<()> {
                    let Some(args) = args else { return Ok(()) };
                    let Some(payload) = PENDING.with(|p| p.borrow_mut().take()) else {
                        return Ok(());
                    };
                    let request = args.Request()?;
                    let package = request.Data()?;
                    if !payload.title.is_empty() {
                        let _ = package
                            .Properties()?
                            .SetTitle(&HSTRING::from(payload.title.as_str()));
                    }
                    if !payload.text.is_empty() {
                        package.SetText(&HSTRING::from(payload.text.as_str()))?;
                    }
                    if !payload.url.is_empty() {
                        if let Ok(uri) = windows::Foundation::Uri::CreateUri(&HSTRING::from(
                            payload.url.as_str(),
                        )) {
                            let _ = package.SetWebLink(&uri);
                        }
                    }
                    Ok(())
                },
            ))
            .map_err(|e| {
                anyhow::anyhow!("DataTransferManager::DataRequested registration failed: {e}")
            })?;

        map.insert(hwnd, manager.clone());
        Ok(manager)
    })
}

#[cfg(target_os = "windows")]
pub fn share(hwnd: isize, title: &str, text: &str, url: &str) -> Result<()> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::IDataTransferManagerInterop;

    let manager = ensure_manager(hwnd)?;
    PENDING.with(|p| {
        *p.borrow_mut() = Some(SharePayload {
            title: title.to_string(),
            text: text.to_string(),
            url: url.to_string(),
        })
    });

    let interop: IDataTransferManagerInterop = windows::core::factory::<
        windows::ApplicationModel::DataTransfer::DataTransferManager,
        IDataTransferManagerInterop,
    >()
    .map_err(|e| anyhow::anyhow!("activating IDataTransferManagerInterop failed: {e}"))?;
    let win = HWND(hwnd as *mut core::ffi::c_void);
    unsafe {
        interop
            .ShowShareUIForWindow(win)
            .map_err(|e| anyhow::anyhow!("ShowShareUIForWindow failed: {e}"))?;
    }
    let _ = manager; // kept alive in MANAGERS; this local is just proof ensure_manager succeeded
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn share(_hwnd: isize, _title: &str, _text: &str, _url: &str) -> Result<()> {
    Err(anyhow::anyhow!(
        "the native share sheet is not yet implemented on this platform"
    ))
}
