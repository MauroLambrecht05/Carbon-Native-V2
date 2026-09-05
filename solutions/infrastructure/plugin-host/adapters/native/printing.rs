// Sends a file to the system print job via Win32's ShellExecuteW "print"
// verb — backs the `print_file` ABI trampoline in abi/host_exports.rs
// (ABI 1.14).
//
// SCOPE: prints an EXISTING FILE (PDF, image, text, ...) through whatever
// the OS has associated as that file type's print handler — not "render
// this HTML/JSX and print it", which would need a whole print-layout
// engine first. An app that wants to print its own UI generates a PDF
// (or another printable file) itself, then calls this — same "app
// supplies the asset, plugin hands it to the OS" shape as taskbar's
// setBadge.
//
// Hand-rolled `extern "system"`, no windows-sys/windows dependency:
// ShellExecuteW's parameters are all integers, wide-string pointers, or
// null — primitive-typed, the same "safe to hand-roll" case as
// instance.rs's CreateMutexW.

use anyhow::{anyhow, Result};

#[cfg(target_os = "windows")]
#[link(name = "shell32")]
extern "system" {
    fn ShellExecuteW(
        hwnd: *mut core::ffi::c_void,
        lp_operation: *const u16,
        lp_file: *const u16,
        lp_parameters: *const u16,
        lp_directory: *const u16,
        n_show_cmd: i32,
    ) -> *mut core::ffi::c_void;
}

#[cfg(target_os = "windows")]
const SW_HIDE: i32 = 0;

#[cfg(target_os = "windows")]
fn wide(s: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

pub fn print_file(path: &str) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err(anyhow!("printing not yet implemented on this platform"))
    }

    #[cfg(target_os = "windows")]
    {
        let operation = wide("print");
        let file = wide(path);
        // ShellExecuteW returns a value > 32 on success (an HINSTANCE, per
        // its own documented and slightly odd contract — anything <= 32
        // is an error code, not a real handle).
        let result = unsafe {
            ShellExecuteW(
                core::ptr::null_mut(),
                operation.as_ptr(),
                file.as_ptr(),
                core::ptr::null(),
                core::ptr::null(),
                SW_HIDE,
            )
        };
        if (result as usize) <= 32 {
            return Err(anyhow!("ShellExecuteW(\"print\") failed: code {}", result as usize));
        }
        Ok(())
    }
}
