// Taskbar badge/progress via Win32's ITaskbarList3 COM interface — backs
// the `taskbar_set_progress`/`taskbar_set_badge` ABI trampolines in
// abi/host_exports.rs (ABI 1.10).
//
// The `windows` crate, not windows-sys: checked directly against the
// downloaded windows-sys 0.59 source and confirmed it generates ZERO COM
// interface wrapper types for Shell — only raw constants/structs/free
// functions. `windows` is specifically the layer that adds real interface
// types (`ITaskbarList3::SetProgressValue` as an actual method) instead of
// this file having to hand-roll and verify a 20-entry vtable byte-for-byte
// against Microsoft's own headers. See Cargo.toml's own comment on this
// dependency for the full reasoning — a deliberate exception to
// windows-sys being this repo's usual choice (carbon-launcher/pipe.rs),
// not a casual one.
//
// BADGE: Windows has no native numeric badge — the accepted equivalent is
// SetOverlayIcon, a small icon composited onto the taskbar button. v1
// scope: the app supplies its own pre-rendered PNG (e.g. a numbered
// circle it draws or ships as an asset) — decoded the same way tray's
// icon is, via the `image` crate — rather than this call rasterizing text
// into one itself.
//
// PLATFORM: Windows-only — ITaskbarList3 has no equivalent on macOS/Linux
// (a dock badge on macOS is a different, separate API entirely).
//
// COM THREADING: `CoInitializeEx` must run on the thread that owns the
// window before ITaskbarList3 is usable there — same JS/event-loop-thread
// constraint as tray.rs/menu.rs (both trampolines here are called
// synchronously from a plugin's JS-thread-only `set_global_function`
// callback), so a `thread_local!` COM-initialized flag, initialized
// lazily on first use, is correct and sufficient — no cross-thread COM
// marshaling is ever needed.

use anyhow::{anyhow, Result};
use std::cell::{Cell, RefCell};
use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{ITaskbarList3, TaskbarList, TBPF_NOPROGRESS, TBPF_NORMAL};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconFromResourceEx, DestroyIcon, HICON, LR_DEFAULTCOLOR,
};

thread_local! {
    static COM_READY: Cell<bool> = const { Cell::new(false) };
    static TASKBAR_LIST: RefCell<Option<ITaskbarList3>> = const { RefCell::new(None) };
}

fn ensure_com_initialized() {
    COM_READY.with(|ready| {
        if !ready.get() {
            unsafe {
                // A failure here (e.g. already initialized with a
                // different concurrency model by something else on this
                // thread) is not fatal — CoCreateInstance below will
                // simply fail too, and every caller already treats that
                // as a normal, reportable error, not a panic.
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ready.set(true);
        }
    });
}

fn with_taskbar_list<T>(f: impl FnOnce(&ITaskbarList3) -> Result<T>) -> Result<T> {
    ensure_com_initialized();
    TASKBAR_LIST.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            let list: ITaskbarList3 = unsafe {
                let list: ITaskbarList3 =
                    CoCreateInstance(&TaskbarList, None, CLSCTX_INPROC_SERVER)
                        .map_err(|e| anyhow!("CoCreateInstance(TaskbarList) failed: {e}"))?;
                list.HrInit()
                    .map_err(|e| anyhow!("ITaskbarList3::HrInit failed: {e}"))?;
                list
            };
            *slot = Some(list);
        }
        f(slot.as_ref().expect("just set or already present"))
    })
}

fn wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// `total == 0` clears the progress overlay (TBPF_NOPROGRESS); otherwise
/// sets it to `completed`/`total` (TBPF_NORMAL).
pub fn set_progress(hwnd: isize, completed: u64, total: u64) -> Result<()> {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    with_taskbar_list(|list| unsafe {
        let state = if total == 0 {
            TBPF_NOPROGRESS
        } else {
            TBPF_NORMAL
        };
        list.SetProgressState(hwnd, state)
            .map_err(|e| anyhow!("SetProgressState failed: {e}"))?;
        if total != 0 {
            list.SetProgressValue(hwnd, completed, total)
                .map_err(|e| anyhow!("SetProgressValue failed: {e}"))?;
        }
        Ok(())
    })
}

/// `icon_path` empty clears the overlay icon. `description` is the
/// accessible tooltip text (may be empty).
pub fn set_badge(hwnd: isize, icon_path: &str, description: &str) -> Result<()> {
    let hwnd = HWND(hwnd as *mut core::ffi::c_void);
    let hicon: HICON = if icon_path.is_empty() {
        HICON::default()
    } else {
        let img = image::open(icon_path)?.into_rgba8();
        let (width, height) = img.dimensions();
        let mut raw = img.into_raw();
        unsafe {
            CreateIconFromResourceEx(
                raw.as_mut_slice(),
                true,        // fIcon: an icon, not a cursor
                0x0003_0000, // dwVersion — 3.0, the documented required value
                width as i32,
                height as i32,
                LR_DEFAULTCOLOR,
            )?
        }
    };
    let desc_wide = wide(description);
    let result = with_taskbar_list(|list| unsafe {
        list.SetOverlayIcon(hwnd, hicon, PCWSTR(desc_wide.as_ptr()))
            .map_err(|e| anyhow!("SetOverlayIcon failed: {e}"))
    });
    if !hicon.is_invalid() {
        unsafe {
            // SetOverlayIcon copies what it needs internally — the handle
            // is safe to destroy right after the call, same as any other
            // Win32 API taking a HICON by value.
            let _ = DestroyIcon(hicon);
        }
    }
    result
}
