// The Win32 surface the snapshot needs: VirtualAlloc at a fixed base,
// file mapping, and the handful of constants that go with them.
//
// Its own file because it is the ONLY part of this crate that is
// platform-specific — everything else is arithmetic over a byte range.

use std::ffi::c_void;
extern "system" {
    pub fn VirtualAlloc(
        lpAddress: *mut c_void,
        dwSize: usize,
        flAllocationType: u32,
        flProtect: u32,
    ) -> *mut c_void;
    pub fn VirtualFree(lpAddress: *mut c_void, dwSize: usize, dwFreeType: u32) -> i32;
    pub fn GetModuleHandleW(lpModuleName: *const u16) -> *mut c_void;
    pub fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        sec: *mut c_void,
        disposition: u32,
        flags: u32,
        template: *mut c_void,
    ) -> *mut c_void;
    pub fn CreateFileMappingW(
        file: *mut c_void,
        sec: *mut c_void,
        protect: u32,
        max_hi: u32,
        max_lo: u32,
        name: *const u16,
    ) -> *mut c_void;
    pub fn MapViewOfFileEx(
        mapping: *mut c_void,
        desired: u32,
        off_hi: u32,
        off_lo: u32,
        bytes: usize,
        base: *mut c_void,
    ) -> *mut c_void;
    pub fn CloseHandle(h: *mut c_void) -> i32;
}
pub const MEM_COMMIT: u32 = 0x1000;
pub const MEM_RESERVE: u32 = 0x2000;
pub const MEM_RELEASE: u32 = 0x8000;
pub const PAGE_READWRITE: u32 = 0x04;
pub const PAGE_WRITECOPY: u32 = 0x08;
pub const GENERIC_READ: u32 = 0x8000_0000;
pub const FILE_SHARE_READ: u32 = 0x1;
pub const OPEN_EXISTING: u32 = 3;
pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
pub const FILE_MAP_COPY: u32 = 0x1;
pub const INVALID_HANDLE_VALUE: isize = -1;
