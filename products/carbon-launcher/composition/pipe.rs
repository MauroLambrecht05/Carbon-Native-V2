// Named-pipe IPC for the daemon — see Cargo.toml's own comment for why
// windows-sys specifically, over the alternatives that were considered and
// rejected. Everything here is synchronous/blocking: the daemon serves one
// connection at a time on a dedicated thread per connection, which is all a
// handful of occasional `carbon run` clients ever needs — no async runtime,
// no overlapped I/O.

use anyhow::{anyhow, Context, Result};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_PIPE_CONNECTED, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::{
    GetTokenInformation, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_NONE,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// The current process's user SID, as its canonical `S-1-5-...` string form
/// — used to build an explicit (not aliased) security descriptor. Aliases
/// like SDDL's `OW` ("owner rights") have inconsistent meaning outside
/// inherited-ACE contexts, which a freshly `CreateNamedPipeW`'d object is
/// not; an explicit SID string has no such ambiguity.
fn current_user_sid_string() -> Result<String> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(anyhow!("OpenProcessToken failed: {}", GetLastError()));
        }
        let mut needed: u32 = 0;
        // First call with a zero-size buffer to learn how much space
        // TokenUser actually needs — the standard two-call GetTokenInformation
        // pattern.
        let _ = GetTokenInformation(token, windows_sys::Win32::Security::TokenUser, null_mut(), 0, &mut needed);
        if needed == 0 {
            CloseHandle(token);
            return Err(anyhow!("GetTokenInformation(TokenUser) returned no size"));
        }
        let mut buf = vec![0u8; needed as usize];
        let ok = GetTokenInformation(
            token,
            windows_sys::Win32::Security::TokenUser,
            buf.as_mut_ptr() as *mut _,
            needed,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(anyhow!("GetTokenInformation(TokenUser) failed: {}", GetLastError()));
        }
        let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid = token_user.User.Sid;

        let mut sid_str_ptr: *mut u16 = null_mut();
        let ok = windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW(sid, &mut sid_str_ptr);
        if ok == 0 || sid_str_ptr.is_null() {
            return Err(anyhow!("ConvertSidToStringSidW failed: {}", GetLastError()));
        }
        let mut len = 0usize;
        while *sid_str_ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(sid_str_ptr, len);
        let sid_string = String::from_utf16_lossy(slice);
        LocalFree(sid_str_ptr as *mut core::ffi::c_void);
        Ok(sid_string)
    }
}

/// A `SECURITY_ATTRIBUTES` restricting the pipe to the current user's SID +
/// SYSTEM (`GA` = generic all, `A` = allow). Leaked deliberately: the
/// descriptor must outlive every `CreateNamedPipeW` call for the daemon's
/// full lifetime, which is the whole point of a daemon — there is no
/// natural point to free it before process exit, and the OS reclaims it
/// then regardless.
fn user_and_system_security_attributes() -> Result<SECURITY_ATTRIBUTES> {
    let sid = current_user_sid_string().context("resolving current user SID for pipe ACL")?;
    let sddl = format!("D:(A;;GA;;;{sid})(A;;GA;;;SY)");
    let sddl_wide = wide(&sddl);
    let mut psd: *mut SECURITY_DESCRIPTOR = null_mut();
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl_wide.as_ptr(),
            windows_sys::Win32::Security::Authorization::SDDL_REVISION_1,
            &mut psd as *mut _ as *mut *mut core::ffi::c_void,
            null_mut(),
        )
    };
    if ok == 0 {
        return Err(anyhow!(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW failed: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd as *mut core::ffi::c_void,
        bInheritHandle: 0,
    })
}

/// A server-side named pipe, restricted to the current user + SYSTEM. One
/// instance handles ONE connection at a time (`ConnectNamedPipe` blocks
/// until a client connects; `accept` below is called again per connection —
/// this file has no instance pooling of its own, `daemon.rs` re-creates a
/// fresh listener after each accept).
pub struct PipeServer {
    handle: HANDLE,
}

/// Marker text `bind()` returns (as the error) when another instance of this
/// daemon already holds the pipe — see `bind()`'s own doc comment and
/// `run_daemon()`'s handling of it.
pub const PIPE_ALREADY_BOUND: &str = "PIPE_ALREADY_BOUND";

impl PipeServer {
    /// Creates (but does not yet accept a connection on) a named pipe at
    /// `\\.\pipe\<name>`.
    ///
    /// `FILE_FLAG_FIRST_PIPE_INSTANCE` makes this call fail with
    /// `ERROR_ACCESS_DENIED` if a pipe with this name already exists, rather
    /// than silently succeeding as a second, independent instance —
    /// `PIPE_UNLIMITED_INSTANCES` on the ORIGINAL bind still lets that first
    /// instance accept unlimited sequential connections (this daemon reuses
    /// one handle across every `accept()`/`disconnect()` cycle, never
    /// re-binds), so this only ever blocks a genuinely SECOND daemon process,
    /// not a second client. Without this flag, two `carbon-launcher daemon`
    /// processes racing to start (e.g. both spawned by a background
    /// warm-up from two concurrent `carbon run`s) would both bind
    /// successfully and run two independent pools forever — this is the
    /// native, race-free alternative to a lock file.
    pub fn bind(name: &str) -> Result<Self> {
        let full_name = format!(r"\\.\pipe\{name}");
        let name_wide = wide(&full_name);
        let sa = user_and_system_security_attributes()?;
        let handle = unsafe {
            CreateNamedPipeW(
                name_wide.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                4096,
                4096,
                0,
                &sa,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let err = unsafe { GetLastError() };
            if err == ERROR_ACCESS_DENIED {
                return Err(anyhow!(PIPE_ALREADY_BOUND));
            }
            return Err(anyhow!("CreateNamedPipeW({full_name}) failed: {err}"));
        }
        Ok(Self { handle })
    }

    /// Blocks until a client connects. `ERROR_PIPE_CONNECTED` (a client
    /// already connected in the tiny window between `CreateNamedPipeW` and
    /// this call) is success, not an error — the documented Win32 race this
    /// API always has to account for.
    pub fn accept(&self) -> Result<PipeConnection> {
        let ok = unsafe { ConnectNamedPipe(self.handle, null_mut()) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err != ERROR_PIPE_CONNECTED {
                return Err(anyhow!("ConnectNamedPipe failed: {err}"));
            }
        }
        Ok(PipeConnection { handle: self.handle, owns_handle: false })
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

/// One accepted connection. When the DAEMON side is done with it, it must
/// `DisconnectNamedPipe` (not just close the handle) so the SAME pipe
/// instance can be reused for the next `accept()` — see `daemon.rs`'s
/// accept loop.
pub struct PipeConnection {
    handle: HANDLE,
    /// True only for a CLIENT connection (opened via `connect`, below) —
    /// those close their handle outright on drop. A SERVER-side connection
    /// (from `PipeServer::accept`) does NOT own the underlying pipe
    /// instance; disconnecting (not closing) is the caller's job via
    /// `disconnect()`, done explicitly rather than in `Drop`, so a forgotten
    /// disconnect is a visible bug, not a silent handle leak masked by
    /// finalizer ordering.
    owns_handle: bool,
}

impl PipeConnection {
    /// Client-side: connect to an already-listening server pipe.
    pub fn connect(name: &str) -> Result<Self> {
        let full_name = format!(r"\\.\pipe\{name}");
        let name_wide = wide(&full_name);
        let handle = unsafe {
            CreateFileW(
                name_wide.as_ptr(),
                windows_sys::Win32::Foundation::GENERIC_READ | windows_sys::Win32::Foundation::GENERIC_WRITE,
                FILE_SHARE_NONE,
                null_mut(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(anyhow!("connecting to {full_name} failed: {}", unsafe { GetLastError() }));
        }
        Ok(Self { handle, owns_handle: true })
    }

    /// Explicit server-side teardown — see the `owns_handle` doc comment.
    pub fn disconnect(self) {
        unsafe {
            DisconnectNamedPipe(self.handle);
        }
        std::mem::forget(self); // handle already dealt with; skip Drop's own close
    }

    pub fn write_line(&mut self, line: &str) -> Result<()> {
        let mut bytes = line.as_bytes().to_vec();
        bytes.push(b'\n');
        let mut written = 0u32;
        let ok = unsafe {
            WriteFile(
                self.handle,
                bytes.as_ptr(),
                bytes.len() as u32,
                &mut written,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(anyhow!("WriteFile failed: {}", unsafe { GetLastError() }));
        }
        Ok(())
    }

    /// Reads until a `\n` (or EOF). Returns `None` on a clean pipe close
    /// (the far end disconnected) rather than erroring — that's an
    /// ordinary, expected way for a connection to end.
    pub fn read_line(&mut self) -> Result<Option<String>> {
        let mut out = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let mut read = 0u32;
            let ok = unsafe { ReadFile(self.handle, byte.as_mut_ptr(), 1, &mut read, null_mut()) };
            if ok == 0 || read == 0 {
                if out.is_empty() {
                    return Ok(None);
                }
                break;
            }
            if byte[0] == b'\n' {
                break;
            }
            out.push(byte[0]);
        }
        Ok(Some(String::from_utf8_lossy(&out).into_owned()))
    }
}

impl Drop for PipeConnection {
    fn drop(&mut self) {
        if self.owns_handle {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}
