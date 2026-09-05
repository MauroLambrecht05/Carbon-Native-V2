// Screen-reader-active detection — backs the `accessibility_query` ABI
// trampoline in abi/host_exports.rs (ABI 1.13).
//
// Hand-rolled `extern "system"`, same reasoning as theme.rs: a single
// primitive out-param through SystemParametersInfoW, no struct/COM
// involved.
//
// PLATFORM: Windows-only for now.

use anyhow::Result;

#[cfg(target_os = "windows")]
extern "system" {
    fn SystemParametersInfoW(
        ui_action: u32,
        ui_param: u32,
        pv_param: *mut core::ffi::c_void,
        f_win_ini: u32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
const SPI_GETSCREENREADER: u32 = 0x0046;

/// Best-effort: Windows sets this flag whenever ANY screen-reader-class
/// assistive technology has registered itself as running (Narrator, JAWS,
/// NVDA all do this) — not a guarantee something is actively speaking
/// right now, the same signal browsers use for this same purpose.
pub fn screen_reader_active() -> Result<bool> {
    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow::anyhow!(
            "screen-reader detection not yet implemented on this platform"
        ))
    }

    #[cfg(target_os = "windows")]
    {
        let mut active: i32 = 0;
        let ok = unsafe {
            SystemParametersInfoW(
                SPI_GETSCREENREADER,
                0,
                &mut active as *mut _ as *mut core::ffi::c_void,
                0,
            )
        };
        // A failed query defaults to "not active" rather than an error —
        // same best-effort spirit as theme.rs's own queries.
        Ok(ok != 0 && active != 0)
    }
}
