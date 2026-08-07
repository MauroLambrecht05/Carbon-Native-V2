// snapshot.rs — native QuickJS heap snapshot/restore for carbon-mini.
//
// THE IDEA (why this works at all)
// --------------------------------
// QuickJS keeps its *entire* VM state — the JSRuntime struct, the JSContext,
// every JSObject / JSString / JSShape / atom, the global object, all the
// library closures built during module-init — in malloc'd memory. Normally
// those allocations are scattered across the process heap at ASLR-randomized
// addresses, and the pointers between them are absolute. You can't just dump
// that memory and load it back into another process: every pointer would be
// dangling.
//
// We make it dumpable by removing both sources of variance:
//
//   1. All QuickJS allocations are routed through a CUSTOM allocator
//      (`JS_NewRuntime2` lets us supply `JSMallocFunctions`). That allocator
//      hands out memory from ONE contiguous region that we `VirtualAlloc` at a
//      FIXED virtual address. Because every object — including the JSRuntime
//      struct itself (quickjs.c allocates it via `mf->js_calloc`) — lives in
//      that region at a constant base, every heap→heap pointer is identical
//      from one process to the next. Snapshot = copy the region's bytes;
//      restore = map the region at the same address and copy the bytes back.
//      No pointer relocation, no fixup table.
//
//   2. The heap also contains CODE pointers: `rt->mf` (our allocator fns),
//      the per-class `call`/`finalizer`/`gc_mark` slots, and every built-in
//      method object (`JSON.stringify`, `Array.prototype.map`, …) stores a C
//      function pointer into our statically-linked QuickJS + Rust code. Those
//      are only constant across processes if the executable itself loads at a
//      constant base — so the `snapshot` feature links the binary with
//      `/DYNAMICBASE:NO` (see build.rs). We record the module base in the
//      snapshot header and refuse to restore if it ever differs, so a mismatch
//      fails loudly instead of corrupting the heap.
//
// What is NOT in the snapshot, and how we handle it:
//   - Host functions (`__cm_*`, native OS imports) are rquickjs closures backed
//     by Rust `Box`es that live OUTSIDE the arena. We therefore snapshot the
//     heap BEFORE registering them, and register them fresh after restore. The
//     bundle calls them as bare globals (`__cm_create_node(...)`), resolved by
//     name at call time, so a snapshot with no `__cm_*` properties is fine as
//     long as we add them back before any JS runs.
//   - The C stack: snapshots are taken at the JS top level (no live C frames
//     referencing arena objects), and `JS_UpdateStackTop` is called after
//     restore so stack-overflow checks use the new thread's stack.
//
// The allocator itself keeps ALL of its bookkeeping (bump cursor, per-size
// free-list heads, the huge-block list) inside the arena's control block, so
// the allocator state is captured and restored together with the heap. It is a
// deliberately simple segregated free-list + bump design: O(1) alloc/free, no
// coalescing. Correctness over compactness — heap compactness is measured and
// revisited only if the snapshot grows too large.
//
// Windows-only for now (the runtime is Windows-focused). The public entry
// points are no-ops / errors on other platforms so the crate still compiles.

#![allow(dead_code)]

use std::ffi::c_void;

// ── Fixed arena geometry ────────────────────────────────────────────────────

/// Base virtual address for the arena. Chosen high in the 128-TiB user VA
/// space, 64 KiB-aligned (Windows allocation granularity), where nothing else
/// in the process maps — so the fixed-address reservation reliably succeeds.
const ARENA_BASE_ADDR: usize = 0x0000_2A00_0000_0000;
/// How much VA to reserve (NOT commit — reservation is free; pages are
/// committed on demand as the allocator grows). 2 GiB is comfortably above the
/// 256 MiB JS heap cap the real runtime sets.
const ARENA_RESERVE: usize = 2 * 1024 * 1024 * 1024;
/// Commit growth granularity.
const COMMIT_CHUNK: usize = 4 * 1024 * 1024;
const PAGE: usize = 4096;

/// Allocations with a (16-byte-rounded) payload at or below this size use the
/// O(1) segregated free lists. Larger ones use the huge-block list.
const MAX_SMALL_PAYLOAD: usize = 1024 * 1024; // 1 MiB
/// Number of small size classes: payload 16,32,…,MAX_SMALL_PAYLOAD.
const NUM_CLASSES: usize = MAX_SMALL_PAYLOAD / 16; // 65536

/// 16-byte per-allocation header. `size` is the rounded payload size in bytes
/// (what the allocator considers this block to be), recoverable from just the
/// user pointer so `free`/`realloc`/`usable_size` work without a size arg.
#[repr(C)]
#[derive(Clone, Copy)]
struct Hdr {
    size: u64,
    magic: u32,
    _pad: u32,
}
const HDR_SIZE: usize = 16;
const HDR_MAGIC: u32 = 0xC0DECAFE;

/// Arena control block, placed at `ARENA_BASE_ADDR`. Everything the allocator
/// needs lives here so the whole allocator state round-trips with the snapshot.
/// Field layout is `#[repr(C)]` and version-tagged; never reorder without
/// bumping `SNAP_VERSION`.
#[repr(C)]
struct Control {
    magic: u64,
    version: u64,
    exe_base: u64,    // module base of carbon-mini.exe at build time (ASLR guard)
    base: u64,        // == ARENA_BASE_ADDR
    reserve: u64,     // == ARENA_RESERVE
    committed: u64,   // bytes committed from base
    bump: u64,        // next fresh-allocation address
    data_start: u64,  // first allocatable address (past this struct)
    rt: u64,          // *mut JSRuntime
    ctx: u64,         // *mut JSContext
    huge_head: u64,   // free list of huge blocks (header addresses)
    alloc_calls: u64, // stats
    live_bytes: u64,  // stats: currently-handed-out payload bytes (approx)
    free_heads: [u64; NUM_CLASSES], // per-class free-list heads (header addrs)
}

const SNAP_MAGIC: u64 = 0x434D5F534E_415031; // "CM_SNAP1" -ish
const SNAP_VERSION: u64 = 2;

/// Single global pointing at the in-arena control block. Set on build-init and
/// on restore. The JS runs single-threaded on the JS thread, and the allocator
/// is only ever called from there, so a plain `static mut` raw pointer is safe.
static mut CTRL: *mut Control = std::ptr::null_mut();

#[inline]
fn round16(n: usize) -> usize {
    (n + 15) & !15
}
#[inline]
fn align_up(n: usize, a: usize) -> usize {
    (n + a - 1) & !(a - 1)
}

// ── Windows VirtualAlloc bindings ────────────────────────────────────────────

#[cfg(windows)]
mod win {
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
}

#[cfg(windows)]
fn to_wide(s: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    s.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// Base address of the main executable module. Constant across runs only when
/// the binary is linked with `/DYNAMICBASE:NO`; used as the snapshot's ASLR
/// guard.
#[cfg(windows)]
pub fn exe_base() -> u64 {
    unsafe { win::GetModuleHandleW(std::ptr::null()) as u64 }
}
#[cfg(not(windows))]
pub fn exe_base() -> u64 {
    0
}

/// A fingerprint of the binary's CODE LAYOUT. The snapshot bakes in absolute
/// code pointers (the allocator fns in `rt->mf`, every built-in method, class
/// finalizers). `/DYNAMICBASE:NO` keeps the module *base* constant, but a
/// recompile shifts function *offsets* — so a snapshot from a different build
/// holds pointers to the wrong code and must NOT be restored. We sample a few
/// of our own function addresses; any code-layout change (a recompile under
/// LTO touches the whole layout) moves them, so a mismatch reliably rejects a
/// stale snapshot. Combined with `exe_base`, this makes a stale restore fail
/// gracefully (cold-path fallback) instead of crashing.
#[cfg(windows)]
pub fn code_fingerprint() -> u64 {
    let a = cb_malloc as *const () as u64;
    let b = cb_free as *const () as u64;
    let c = cb_realloc as *const () as u64;
    let d = ensure_committed as *const () as u64;
    a.rotate_left(1) ^ b.rotate_left(17) ^ c.rotate_left(33) ^ d.rotate_left(47)
}
#[cfg(not(windows))]
pub fn code_fingerprint() -> u64 {
    0
}

// ── Allocator core (called only via the extern "C" callbacks below) ──────────

#[cfg(windows)]
unsafe fn ensure_committed(up_to: u64) {
    let ctrl = &mut *CTRL;
    let mut committed_end = ctrl.base + ctrl.committed;
    while committed_end < up_to {
        let p = win::VirtualAlloc(
            committed_end as *mut c_void,
            COMMIT_CHUNK,
            win::MEM_COMMIT,
            win::PAGE_READWRITE,
        );
        if p.is_null() {
            // Out of reserved space or commit failed. There is no good recovery
            // path inside a malloc callback; abort so the failure is obvious.
            panic!("carbon-mini snapshot arena: commit failed at {committed_end:#x}");
        }
        ctrl.committed += COMMIT_CHUNK as u64;
        committed_end += COMMIT_CHUNK as u64;
    }
}

#[cfg(windows)]
unsafe fn arena_alloc(req: usize) -> *mut c_void {
    if CTRL.is_null() {
        return std::ptr::null_mut();
    }
    let payload = round16(req.max(1));
    let total = HDR_SIZE + payload;
    let ctrl = &mut *CTRL;
    ctrl.alloc_calls += 1;

    if payload <= MAX_SMALL_PAYLOAD {
        let idx = payload / 16 - 1;
        let head = ctrl.free_heads[idx];
        if head != 0 {
            // Reuse a freed block of the same class.
            let next = *((head + HDR_SIZE as u64) as *const u64);
            ctrl.free_heads[idx] = next;
            ctrl.live_bytes += payload as u64;
            return (head + HDR_SIZE as u64) as *mut c_void;
        }
    } else {
        // Huge: first-fit over the huge list (blocks may be larger than asked).
        let mut prev: u64 = 0;
        let mut cur = ctrl.huge_head;
        while cur != 0 {
            let hdr = &*(cur as *const Hdr);
            let next = *((cur + HDR_SIZE as u64) as *const u64);
            if hdr.size as usize >= payload {
                if prev == 0 {
                    ctrl.huge_head = next;
                } else {
                    *((prev + HDR_SIZE as u64) as *mut u64) = next;
                }
                ctrl.live_bytes += hdr.size;
                return (cur + HDR_SIZE as u64) as *mut c_void;
            }
            prev = cur;
            cur = next;
        }
    }

    // Bump a fresh block.
    let hdr_addr = ctrl.bump;
    ensure_committed(hdr_addr + total as u64);
    ctrl.bump += total as u64;
    let hdr = hdr_addr as *mut Hdr;
    (*hdr).size = payload as u64;
    (*hdr).magic = HDR_MAGIC;
    ctrl.live_bytes += payload as u64;
    (hdr_addr + HDR_SIZE as u64) as *mut c_void
}

#[cfg(windows)]
unsafe fn arena_free(ptr: *mut c_void) {
    if ptr.is_null() || CTRL.is_null() {
        return;
    }
    let hdr_addr = ptr as u64 - HDR_SIZE as u64;
    let hdr = &*(hdr_addr as *const Hdr);
    debug_assert_eq!(hdr.magic, HDR_MAGIC, "arena_free: bad header magic");
    let payload = hdr.size as usize;
    let ctrl = &mut *CTRL;
    ctrl.live_bytes = ctrl.live_bytes.saturating_sub(payload as u64);
    if payload <= MAX_SMALL_PAYLOAD {
        let idx = payload / 16 - 1;
        *((hdr_addr + HDR_SIZE as u64) as *mut u64) = ctrl.free_heads[idx];
        ctrl.free_heads[idx] = hdr_addr;
    } else {
        *((hdr_addr + HDR_SIZE as u64) as *mut u64) = ctrl.huge_head;
        ctrl.huge_head = hdr_addr;
    }
}

#[cfg(windows)]
unsafe fn arena_usable(ptr: *const c_void) -> usize {
    if ptr.is_null() {
        return 0;
    }
    let hdr = &*((ptr as u64 - HDR_SIZE as u64) as *const Hdr);
    hdr.size as usize
}

// extern "C" trampolines matching JSMallocFunctions. NOTE: QuickJS's
// `size_t` binds to `c_ulonglong`, which is a *distinct* type from `usize`
// even though they're the same width here — the fn-pointer types must match
// exactly, so the callbacks take `size_t` and convert internally.
#[cfg(windows)]
type SizeT = std::os::raw::c_ulonglong;

#[cfg(windows)]
pub unsafe extern "C" fn cb_malloc(_opaque: *mut c_void, size: SizeT) -> *mut c_void {
    arena_alloc(size as usize)
}

#[cfg(windows)]
pub unsafe extern "C" fn cb_calloc(_opaque: *mut c_void, count: SizeT, size: SizeT) -> *mut c_void {
    let total = match (count as usize).checked_mul(size as usize) {
        Some(t) => t,
        None => return std::ptr::null_mut(),
    };
    let p = arena_alloc(total);
    if !p.is_null() {
        // Recycled blocks are dirty; zero exactly what calloc promises.
        std::ptr::write_bytes(p as *mut u8, 0, total);
    }
    p
}

#[cfg(windows)]
pub unsafe extern "C" fn cb_free(_opaque: *mut c_void, ptr: *mut c_void) {
    arena_free(ptr)
}

#[cfg(windows)]
pub unsafe extern "C" fn cb_realloc(
    _opaque: *mut c_void,
    ptr: *mut c_void,
    size: SizeT,
) -> *mut c_void {
    let size = size as usize;
    if ptr.is_null() {
        return arena_alloc(size);
    }
    if size == 0 {
        arena_free(ptr);
        return std::ptr::null_mut();
    }
    let old_payload = arena_usable(ptr);
    let new_payload = round16(size.max(1));
    if new_payload <= old_payload {
        // Shrink/keep in place: block stays in its current class.
        return ptr;
    }
    let np = arena_alloc(size);
    if np.is_null() {
        return std::ptr::null_mut();
    }
    std::ptr::copy_nonoverlapping(ptr as *const u8, np as *mut u8, old_payload);
    arena_free(ptr);
    np
}

#[cfg(windows)]
pub unsafe extern "C" fn cb_usable(ptr: *const c_void) -> SizeT {
    arena_usable(ptr) as SizeT
}

// ── Build-time init / snapshot / restore ─────────────────────────────────────

/// The 5 callbacks as a `JSMallocFunctions` table for `JS_NewRuntime2`.
#[cfg(windows)]
pub fn malloc_functions() -> rquickjs::qjs::JSMallocFunctions {
    rquickjs::qjs::JSMallocFunctions {
        js_calloc: Some(cb_calloc),
        js_malloc: Some(cb_malloc),
        js_free: Some(cb_free),
        js_realloc: Some(cb_realloc),
        js_malloc_usable_size: Some(cb_usable),
    }
}

/// Reserve + initialize a fresh arena for building a snapshot. Must be called
/// before `JS_NewRuntime2(&malloc_functions(), ...)`.
#[cfg(windows)]
pub fn init_arena_for_build() -> Result<(), String> {
    unsafe {
        if !CTRL.is_null() {
            return Err("arena already initialized".into());
        }
        // Reserve the whole region at the fixed address.
        let p = win::VirtualAlloc(
            ARENA_BASE_ADDR as *mut c_void,
            ARENA_RESERVE,
            win::MEM_RESERVE,
            win::PAGE_READWRITE,
        );
        if p as usize != ARENA_BASE_ADDR {
            if !p.is_null() {
                win::VirtualFree(p, 0, win::MEM_RELEASE);
            }
            return Err(format!(
                "could not reserve arena at fixed base {ARENA_BASE_ADDR:#x} (got {:#x})",
                p as usize
            ));
        }
        // Commit enough to hold the control block.
        let ctrl_bytes = std::mem::size_of::<Control>();
        let data_start = align_up(ARENA_BASE_ADDR + ctrl_bytes, PAGE);
        let initial_commit = align_up(data_start - ARENA_BASE_ADDR + COMMIT_CHUNK, PAGE);
        let c = win::VirtualAlloc(
            ARENA_BASE_ADDR as *mut c_void,
            initial_commit,
            win::MEM_COMMIT,
            win::PAGE_READWRITE,
        );
        if c.is_null() {
            win::VirtualFree(ARENA_BASE_ADDR as *mut c_void, 0, win::MEM_RELEASE);
            return Err("could not commit arena control block".into());
        }
        // Committed memory is zero-filled by the OS, so the Control struct (incl.
        // all free_heads) starts cleanly zeroed.
        CTRL = ARENA_BASE_ADDR as *mut Control;
        let ctrl = &mut *CTRL;
        ctrl.magic = SNAP_MAGIC;
        ctrl.version = SNAP_VERSION;
        ctrl.exe_base = exe_base();
        ctrl.base = ARENA_BASE_ADDR as u64;
        ctrl.reserve = ARENA_RESERVE as u64;
        ctrl.committed = initial_commit as u64;
        ctrl.data_start = data_start as u64;
        ctrl.bump = data_start as u64;
        ctrl.rt = 0;
        ctrl.ctx = 0;
        ctrl.huge_head = 0;
        ctrl.alloc_calls = 0;
        ctrl.live_bytes = 0;
        Ok(())
    }
}

/// Record the runtime/context pointers into the control block so restore can
/// recover them. Call once after the context + module-init are ready.
#[cfg(windows)]
pub fn set_rt_ctx(rt: *mut c_void, ctx: *mut c_void) {
    unsafe {
        if CTRL.is_null() {
            return;
        }
        let ctrl = &mut *CTRL;
        ctrl.rt = rt as u64;
        ctrl.ctx = ctx as u64;
    }
}

/// Bytes currently in use (bump high-water from the base). This is what the
/// snapshot serializes — it includes the control block, every live object, and
/// freed blocks still threaded onto the free lists.
#[cfg(windows)]
pub fn used_bytes() -> usize {
    unsafe {
        if CTRL.is_null() {
            return 0;
        }
        ((*CTRL).bump - (*CTRL).base) as usize
    }
}

#[cfg(windows)]
pub fn live_bytes() -> usize {
    unsafe {
        if CTRL.is_null() {
            0
        } else {
            (*CTRL).live_bytes as usize
        }
    }
}

/// On-disk snapshot header (fixed-size, little-endian native).
#[repr(C)]
#[derive(Clone, Copy)]
struct FileHeader {
    magic: u64,
    version: u64,
    exe_base: u64,
    fingerprint: u64, // code-layout fingerprint (rejects stale-build snapshots)
    base: u64,
    used: u64, // uncompressed arena length stored
    rt: u64,
    ctx: u64,
    compressed: u64, // 1 = lz4, 0 = raw
}
const FILE_HEADER_SIZE: usize = std::mem::size_of::<FileHeader>();

/// Serialize the current arena to `bytes` (header + lz4(arena[0..used])).
#[cfg(windows)]
pub fn snapshot_to_vec() -> Result<Vec<u8>, String> {
    unsafe {
        if CTRL.is_null() {
            return Err("no arena to snapshot".into());
        }
        let ctrl = &*CTRL;
        let used = (ctrl.bump - ctrl.base) as usize;
        let arena = std::slice::from_raw_parts(ctrl.base as *const u8, used);
        let compressed = lz4_flex::compress(arena);
        let hdr = FileHeader {
            magic: SNAP_MAGIC,
            version: SNAP_VERSION,
            exe_base: ctrl.exe_base,
            fingerprint: code_fingerprint(),
            base: ctrl.base,
            used: used as u64,
            rt: ctrl.rt,
            ctx: ctrl.ctx,
            compressed: 1,
        };
        let mut out = Vec::with_capacity(FILE_HEADER_SIZE + compressed.len());
        let hdr_bytes = std::slice::from_raw_parts(
            &hdr as *const FileHeader as *const u8,
            FILE_HEADER_SIZE,
        );
        out.extend_from_slice(hdr_bytes);
        out.extend_from_slice(&compressed);
        Ok(out)
    }
}

#[cfg(windows)]
pub fn write_snapshot(path: &std::path::Path) -> Result<usize, String> {
    let v = snapshot_to_vec()?;
    std::fs::write(path, &v).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(v.len())
}

/// Result of a successful restore: the runtime + context pointers, ready to be
/// re-wired (host-import registration, `JS_UpdateStackTop`).
pub struct Restored {
    pub rt: *mut c_void,
    pub ctx: *mut c_void,
}

/// Map the arena at its fixed base and copy the snapshot bytes back in. After
/// this returns, the global allocator state is live and the runtime/context
/// pointers are valid — but the caller still owns re-binding host functions and
/// calling `JS_UpdateStackTop`.
#[cfg(windows)]
pub fn restore_from_bytes(data: &[u8]) -> Result<Restored, String> {
    unsafe {
        if !CTRL.is_null() {
            return Err("arena already initialized; cannot restore".into());
        }
        if data.len() < FILE_HEADER_SIZE {
            return Err("snapshot too short".into());
        }
        let mut hdr = std::mem::zeroed::<FileHeader>();
        std::ptr::copy_nonoverlapping(
            data.as_ptr(),
            &mut hdr as *mut FileHeader as *mut u8,
            FILE_HEADER_SIZE,
        );
        if hdr.magic != SNAP_MAGIC {
            return Err("snapshot: bad magic".into());
        }
        if hdr.version != SNAP_VERSION {
            return Err(format!("snapshot: version {} != {SNAP_VERSION}", hdr.version));
        }
        let cur_exe = exe_base();
        if hdr.exe_base != cur_exe {
            return Err(format!(
                "snapshot: exe base mismatch (snapshot {:#x}, current {:#x})",
                hdr.exe_base, cur_exe
            ));
        }
        if hdr.fingerprint != code_fingerprint() {
            return Err("snapshot: code fingerprint mismatch (built by a different binary)".into());
        }
        if hdr.base as usize != ARENA_BASE_ADDR {
            return Err("snapshot: arena base mismatch".into());
        }
        let used = hdr.used as usize;

        // Reserve the full region at the fixed base, then commit what we need.
        let p = win::VirtualAlloc(
            ARENA_BASE_ADDR as *mut c_void,
            ARENA_RESERVE,
            win::MEM_RESERVE,
            win::PAGE_READWRITE,
        );
        if p as usize != ARENA_BASE_ADDR {
            if !p.is_null() {
                win::VirtualFree(p, 0, win::MEM_RELEASE);
            }
            return Err(format!(
                "restore: could not reserve arena at {ARENA_BASE_ADDR:#x} (got {:#x})",
                p as usize
            ));
        }
        let commit_len = align_up(used, PAGE);
        let c = win::VirtualAlloc(
            ARENA_BASE_ADDR as *mut c_void,
            commit_len,
            win::MEM_COMMIT,
            win::PAGE_READWRITE,
        );
        if c.is_null() {
            win::VirtualFree(ARENA_BASE_ADDR as *mut c_void, 0, win::MEM_RELEASE);
            return Err("restore: commit failed".into());
        }

        // Decompress (or copy) the arena bytes DIRECTLY into the committed
        // region — no intermediate Vec, no second copy. The committed pages
        // fault in as we write them.
        let payload = &data[FILE_HEADER_SIZE..];
        let dst = std::slice::from_raw_parts_mut(ARENA_BASE_ADDR as *mut u8, used);
        if hdr.compressed == 1 {
            let n = lz4_flex::decompress_into(payload, dst)
                .map_err(|e| format!("restore: lz4 decompress: {e}"))?;
            if n != used {
                return Err("restore: decompressed length mismatch".into());
            }
        } else {
            if payload.len() < used {
                return Err("restore: raw payload too short".into());
            }
            dst.copy_from_slice(&payload[..used]);
        }

        // The control block is now valid in memory. Point the allocator at it
        // and fix up `committed` to reflect what we actually committed here
        // (build-time may have committed more in COMMIT_CHUNK rounding).
        CTRL = ARENA_BASE_ADDR as *mut Control;
        let ctrl = &mut *CTRL;
        if ctrl.magic != SNAP_MAGIC {
            CTRL = std::ptr::null_mut();
            return Err("restore: in-arena control magic mismatch".into());
        }
        ctrl.committed = commit_len as u64;

        Ok(Restored {
            rt: hdr.rt as *mut c_void,
            ctx: hdr.ctx as *mut c_void,
        })
    }
}

#[cfg(windows)]
pub fn restore_from_file(path: &std::path::Path) -> Result<Restored, String> {
    let data = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    restore_from_bytes(&data)
}

// ── mmap restore (the fast path) ─────────────────────────────────────────────
//
// Instead of decompress+copy upfront, write the arena UNCOMPRESSED and on
// restore memory-map it at the fixed base with copy-on-write. Pages then fault
// in from the file lazily, only as the heap is actually touched — and the
// restore call itself returns in ~microseconds. Metadata lives in a `.meta`
// sidecar so the main file is pure arena bytes mappable from offset 0 (a file
// mapping view offset must be allocation-granularity aligned; a sidecar avoids
// having to pad a header to 64 KiB).

#[cfg(windows)]
pub fn write_snapshot_mmap(path: &std::path::Path) -> Result<usize, String> {
    unsafe {
        if CTRL.is_null() {
            return Err("no arena to snapshot".into());
        }
        let ctrl = &*CTRL;
        let used = (ctrl.bump - ctrl.base) as usize;
        // Pad the file up to 64 KiB granularity so the mapped view ends on an
        // allocation-granularity boundary and the growth reservation can abut
        // it with no gap. The padding is zero (the mapped tail is free heap).
        let used_padded = align_up(used, 64 * 1024);
        let arena = std::slice::from_raw_parts(ctrl.base as *const u8, used);
        {
            use std::io::Write;
            let mut f = std::fs::File::create(path)
                .map_err(|e| format!("create {}: {e}", path.display()))?;
            f.write_all(arena).map_err(|e| format!("write {}: {e}", path.display()))?;
            if used_padded > used {
                f.write_all(&vec![0u8; used_padded - used])
                    .map_err(|e| format!("pad {}: {e}", path.display()))?;
            }
        }
        let hdr = FileHeader {
            magic: SNAP_MAGIC,
            version: SNAP_VERSION,
            exe_base: ctrl.exe_base,
            fingerprint: code_fingerprint(),
            base: ctrl.base,
            used: used_padded as u64,
            rt: ctrl.rt,
            ctx: ctrl.ctx,
            compressed: 0,
        };
        let hdr_bytes = std::slice::from_raw_parts(
            &hdr as *const FileHeader as *const u8,
            FILE_HEADER_SIZE,
        );
        let meta = path.with_extension("meta");
        std::fs::write(&meta, hdr_bytes).map_err(|e| format!("write {}: {e}", meta.display()))?;
        Ok(used)
    }
}

#[cfg(windows)]
pub fn restore_mmap(path: &std::path::Path) -> Result<Restored, String> {
    unsafe {
        if !CTRL.is_null() {
            return Err("arena already initialized; cannot restore".into());
        }
        // Read + validate the metadata sidecar.
        let meta = path.with_extension("meta");
        let mbytes = std::fs::read(&meta).map_err(|e| format!("read {}: {e}", meta.display()))?;
        if mbytes.len() < FILE_HEADER_SIZE {
            return Err("meta too short".into());
        }
        let mut hdr = std::mem::zeroed::<FileHeader>();
        std::ptr::copy_nonoverlapping(
            mbytes.as_ptr(),
            &mut hdr as *mut FileHeader as *mut u8,
            FILE_HEADER_SIZE,
        );
        if hdr.magic != SNAP_MAGIC {
            return Err("mmap restore: bad magic".into());
        }
        if hdr.version != SNAP_VERSION {
            return Err(format!("mmap restore: version {} != {SNAP_VERSION}", hdr.version));
        }
        if hdr.exe_base != exe_base() {
            return Err(format!(
                "mmap restore: exe base mismatch (snapshot {:#x}, current {:#x})",
                hdr.exe_base,
                exe_base()
            ));
        }
        if hdr.fingerprint != code_fingerprint() {
            return Err("mmap restore: code fingerprint mismatch (built by a different binary)".into());
        }
        if hdr.base as usize != ARENA_BASE_ADDR {
            return Err("mmap restore: arena base mismatch".into());
        }
        let used = hdr.used as usize;

        // Open the arena file and create a copy-on-write mapping.
        let wpath = to_wide(path);
        let file = win::CreateFileW(
            wpath.as_ptr(),
            win::GENERIC_READ,
            win::FILE_SHARE_READ,
            std::ptr::null_mut(),
            win::OPEN_EXISTING,
            win::FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if file as isize == win::INVALID_HANDLE_VALUE {
            return Err("mmap restore: CreateFileW failed".into());
        }
        let mapping = win::CreateFileMappingW(
            file,
            std::ptr::null_mut(),
            win::PAGE_WRITECOPY,
            0,
            0,
            std::ptr::null(),
        );
        if mapping.is_null() {
            win::CloseHandle(file);
            return Err("mmap restore: CreateFileMapping failed".into());
        }
        // Map the whole file (offset 0) at the fixed base, copy-on-write.
        let view = win::MapViewOfFileEx(
            mapping,
            win::FILE_MAP_COPY,
            0,
            0,
            used,
            ARENA_BASE_ADDR as *mut c_void,
        );
        if view as usize != ARENA_BASE_ADDR {
            win::CloseHandle(mapping);
            win::CloseHandle(file);
            return Err(format!(
                "mmap restore: MapViewOfFileEx landed at {:#x}, wanted {ARENA_BASE_ADDR:#x}",
                view as usize
            ));
        }
        // The file handle can be closed; the mapping keeps the view alive.
        // (We intentionally leak the mapping handle for the process lifetime.)
        win::CloseHandle(file);

        // Reserve the growth area immediately past the mapped view so the
        // allocator can keep bump-allocating after restore.
        let view_end = align_up(ARENA_BASE_ADDR + used, 64 * 1024);
        let growth = ARENA_RESERVE - (view_end - ARENA_BASE_ADDR);
        if growth > 0 {
            let g = win::VirtualAlloc(
                view_end as *mut c_void,
                growth,
                win::MEM_RESERVE,
                win::PAGE_READWRITE,
            );
            if g.is_null() {
                return Err("mmap restore: could not reserve growth area".into());
            }
        }

        CTRL = ARENA_BASE_ADDR as *mut Control;
        let ctrl = &mut *CTRL;
        if ctrl.magic != SNAP_MAGIC {
            CTRL = std::ptr::null_mut();
            return Err("mmap restore: in-arena control magic mismatch".into());
        }
        // The mapped view is COW-backed up to `view_end`; everything up to there
        // is effectively committed (faults in from the file / zero-fill).
        ctrl.committed = (view_end - ARENA_BASE_ADDR) as u64;

        Ok(Restored {
            rt: hdr.rt as *mut c_void,
            ctx: hdr.ctx as *mut c_void,
        })
    }
}

// ── Non-Windows stubs (keep the crate compiling elsewhere) ───────────────────

#[cfg(not(windows))]
pub fn init_arena_for_build() -> Result<(), String> {
    Err("snapshot is Windows-only".into())
}
#[cfg(not(windows))]
pub fn set_rt_ctx(_rt: *mut c_void, _ctx: *mut c_void) {}
#[cfg(not(windows))]
pub fn used_bytes() -> usize {
    0
}
#[cfg(not(windows))]
pub fn live_bytes() -> usize {
    0
}
#[cfg(not(windows))]
pub fn write_snapshot(_path: &std::path::Path) -> Result<usize, String> {
    Err("snapshot is Windows-only".into())
}
#[cfg(not(windows))]
pub struct Restored {
    pub rt: *mut c_void,
    pub ctx: *mut c_void,
}
#[cfg(not(windows))]
pub fn restore_from_file(_path: &std::path::Path) -> Result<Restored, String> {
    Err("snapshot is Windows-only".into())
}
