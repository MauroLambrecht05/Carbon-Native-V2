// Single-instance lock via a Windows named mutex — backs the
// `instance_acquire` ABI trampoline in abi/host_exports.rs (ABI 1.8).
//
// No `windows-sys` dependency: `CreateMutexW`/`GetLastError` are
// primitive-typed calls (the one struct-pointer parameter, security
// attributes, is always passed null here — default security, no ACL to
// lay out) — the same "safe to hand-roll" case mini.rs's own
// `ShowWindowAsync`/`SetProcessDpiAwarenessContext` externs already are.
// `windows-sys` is reserved for calls that genuinely need a non-trivial
// struct layout (see carbon-launcher/pipe.rs's own Cargo.toml comment on
// exactly that distinction).
//
// PLATFORM: Windows-only for now, like several other native modules here
// — a named mutex is a Windows-specific primitive; macOS/Linux need a
// different mechanism (a lock file with `flock`, or a well-known Unix
// domain socket) entirely, not stubbed out here rather than guessed at.

use anyhow::{anyhow, Result};

#[cfg(target_os = "windows")]
extern "system" {
    fn CreateMutexW(
        attrs: *mut core::ffi::c_void,
        initial_owner: i32,
        name: *const u16,
    ) -> *mut core::ffi::c_void;
    fn GetLastError() -> u32;
}

#[cfg(target_os = "windows")]
const ERROR_ALREADY_EXISTS: u32 = 183;

#[cfg(target_os = "windows")]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Acquires the lock. Returns `Ok(())` if this is the first/only instance
/// — the only case that actually returns to the caller in practice, since
/// the alternative calls `std::process::exit` directly (matching
/// `deeplink_register`'s "may not return at all" contract, documented on
/// `instance_acquire` in carbon_plugin.h).
///
/// The mutex handle is deliberately never closed: it must stay held for
/// the entire process lifetime (there is no "release" verb — see the
/// header doc), and the OS reclaims it automatically on process exit
/// regardless, including a crash. Leaking the handle here is simpler and
/// exactly as correct as tracking it in a static just to never use it.
pub fn acquire(app_id: &str) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app_id;
        Err(anyhow!("single-instance lock not yet implemented on this platform"))
    }

    #[cfg(target_os = "windows")]
    {
        // "Local\" (not "Global\") — this app's own session only, matching
        // how a single desktop user's launches are what "already running"
        // should mean; a Global namespace would require SeCreateGlobalPrivilege
        // considerations this doesn't need to take on.
        let name = wide(&format!("Local\\carbon-app-{app_id}"));
        let handle = unsafe { CreateMutexW(core::ptr::null_mut(), 1, name.as_ptr()) };
        if handle.is_null() {
            // Best-effort: don't block the app from starting just because
            // the OS refused to create the lock primitive itself.
            return Err(anyhow!("CreateMutexW failed"));
        }
        let already_running = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        if already_running {
            std::process::exit(0);
        }
        Ok(())
    }
}
