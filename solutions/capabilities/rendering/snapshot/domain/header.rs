// The on-disk snapshot format: the header, the control block, and the
// alignment arithmetic that lays them out.
//
// Separate from lib.rs because this is the part that is FROZEN. A field
// added here invalidates every snapshot already written to a user's disk,
// while the code that reads and writes them can change freely.

use super::*;

/// 16-byte per-allocation header. `size` is the rounded payload size in bytes
/// (what the allocator considers this block to be), recoverable from just the
/// user pointer so `free`/`realloc`/`usable_size` work without a size arg.
#[repr(C)]
#[derive(Clone, Copy)]
pub(crate) struct Hdr {
    pub(crate) size: u64,
    pub(crate) magic: u32,
    pub(crate) _pad: u32,
}
/// Arena control block, placed at `ARENA_BASE_ADDR`. Everything the allocator
/// needs lives here so the whole allocator state round-trips with the snapshot.
/// Field layout is `#[repr(C)]` and version-tagged; never reorder without
/// bumping `SNAP_VERSION`.
#[repr(C)]
pub(crate) struct Control {
    pub(crate) magic: u64,
    pub(crate) version: u64,
    pub(crate) exe_base: u64, // module base of carbon-mini.exe at build time (ASLR guard)
    pub(crate) base: u64,     // == ARENA_BASE_ADDR
    pub(crate) reserve: u64,  // == ARENA_RESERVE
    pub(crate) committed: u64, // bytes committed from base
    pub(crate) bump: u64,     // next fresh-allocation address
    pub(crate) data_start: u64, // first allocatable address (past this struct)
    pub(crate) rt: u64,       // *mut JSRuntime
    pub(crate) ctx: u64,      // *mut JSContext
    pub(crate) huge_head: u64, // free list of huge blocks (header addresses)
    pub(crate) alloc_calls: u64, // stats
    pub(crate) live_bytes: u64, // stats: currently-handed-out payload bytes (approx)
    pub(crate) free_heads: [u64; NUM_CLASSES], // per-class free-list heads (header addrs)
}

#[inline]
pub(crate) fn round16(n: usize) -> usize {
    (n + 15) & !15
}
#[inline]
pub(crate) fn align_up(n: usize, a: usize) -> usize {
    (n + a - 1) & !(a - 1)
}

// ── Windows VirtualAlloc bindings ────────────────────────────────────────────
