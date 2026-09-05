// Accent color, high-contrast, and reduced-motion preference detection —
// backs the `theme_query` ABI trampoline in abi/host_exports.rs (ABI
// 1.11). Live theme (light/dark) and window-focus change events already
// exist ambiently (`onThemeChange`/`onWindowFocus` in the Solid renderer's
// app-events.ts) — this plugin covers the three preferences that weren't
// wired up anywhere yet.
//
// Hand-rolled `extern "system"` declarations, no windows-sys/windows
// dependency: every call here is primitive-typed (SystemParametersInfoW's
// HIGHCONTRAST struct is a small, fixed, POD layout with no ownership/COM
// lifetime concerns — safe to define by hand, same "safe to hand-roll"
// case mini.rs's own ShowWindowAsync/SetProcessDpiAwarenessContext
// already are; DwmGetColorizationColor's two out-params are plain
// integers). See instance.rs's header for the fuller version of this
// reasoning.
//
// REDUCED MOTION: Windows has no direct "prefers-reduced-motion" API —
// SPI_GETCLIENTAREAANIMATION (whether client-area animations are
// enabled) is the same signal Firefox uses on Windows for exactly this
// preference, not a guess specific to this file.
//
// PLATFORM: Windows-only for now, like several other native modules here.

use anyhow::Result;
use serde::Serialize;

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
#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetColorizationColor(pcr_colorization: *mut u32, pf_opaque_blend: *mut i32) -> i32;
}

#[cfg(target_os = "windows")]
const SPI_GETHIGHCONTRAST: u32 = 0x0042;
#[cfg(target_os = "windows")]
const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;
#[cfg(target_os = "windows")]
const HCF_HIGHCONTRASTON: u32 = 0x0000_0001;

// Mirrors Win32's HIGHCONTRASTW exactly — cbSize/dwFlags/lpszDefaultScheme,
// in that order, that size, nothing appended (this is a query-only local,
// never handed to a plugin or crossing any ABI of ours, so there's no
// append-only concern the way carbon_plugin.h's own structs have).
#[cfg(target_os = "windows")]
#[repr(C)]
struct HighContrastW {
    cb_size: u32,
    dw_flags: u32,
    lpsz_default_scheme: *mut u16,
}

#[derive(Serialize)]
pub struct ThemePrefs {
    /// "#RRGGBB" — the current Windows accent color, always opaque
    /// (the alpha DWM reports is about window-frame blending, not
    /// relevant to an app-facing swatch, so it's dropped here).
    #[serde(rename = "accentColor")]
    pub accent_color: String,
    #[serde(rename = "highContrast")]
    pub high_contrast: bool,
    #[serde(rename = "reducedMotion")]
    pub reduced_motion: bool,
}

pub fn query() -> Result<ThemePrefs> {
    #[cfg(not(target_os = "windows"))]
    {
        Err(anyhow::anyhow!("theme preference detection not yet implemented on this platform"))
    }

    #[cfg(target_os = "windows")]
    {
        let accent_color = unsafe {
            let mut colorization: u32 = 0;
            let mut opaque: i32 = 0;
            let hr = DwmGetColorizationColor(&mut colorization, &mut opaque);
            if hr < 0 {
                "#000000".to_string()
            } else {
                // DWMCOLORIZATIONCOLOR is 0xAARRGGBB — alpha dropped, per
                // this struct's own doc comment.
                format!(
                    "#{:02X}{:02X}{:02X}",
                    (colorization >> 16) & 0xFF,
                    (colorization >> 8) & 0xFF,
                    colorization & 0xFF
                )
            }
        };

        let high_contrast = unsafe {
            let mut hc = HighContrastW {
                cb_size: core::mem::size_of::<HighContrastW>() as u32,
                dw_flags: 0,
                lpsz_default_scheme: core::ptr::null_mut(),
            };
            let ok = SystemParametersInfoW(
                SPI_GETHIGHCONTRAST,
                core::mem::size_of::<HighContrastW>() as u32,
                &mut hc as *mut _ as *mut core::ffi::c_void,
                0,
            );
            ok != 0 && (hc.dw_flags & HCF_HIGHCONTRASTON) != 0
        };

        let reduced_motion = unsafe {
            let mut animations_enabled: i32 = 1;
            let ok = SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                &mut animations_enabled as *mut _ as *mut core::ffi::c_void,
                0,
            );
            // Animations disabled == the user prefers reduced motion.
            // A failed query defaults to "animations on" (the Windows
            // default), i.e. reduced_motion = false, not an error — same
            // best-effort spirit as this file's other two queries.
            ok != 0 && animations_enabled == 0
        };

        Ok(ThemePrefs { accent_color, high_contrast, reduced_motion })
    }
}
