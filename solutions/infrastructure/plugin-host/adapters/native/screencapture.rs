// Still screenshots of a window or the full display, via classic GDI
// BitBlt — backs the `screen_capture` ABI trampoline in
// abi/host_exports.rs (ABI 1.15).
//
// Hand-rolled `extern "system"`, no windows-sys/windows dependency: every
// struct here (RECT, BITMAPINFOHEADER, BITMAPINFO) is a small, fixed, POD
// layout straight from the Win32 SDK headers — no ownership/COM lifetime
// concerns, the same "safe to hand-roll" case theme.rs's HIGHCONTRASTW
// already is. PNG encoding reuses the `image` crate (already a dependency
// behind the `taskbar` feature, for the same purpose there).
//
// SCOPE: still images only — no recording, no per-window "exclude from
// capture" flag (a separate, later capability if ever built). Encodes
// straight to a PNG file at the given path; there is no "return raw
// pixels to JS" path, matching the existing convention of native code
// producing a file/path rather than crossing the ABI with a large binary
// blob (see dialog's own file-based dialogs for the same shape).
//
// PLATFORM: Windows-only for now.

use anyhow::{anyhow, Result};

#[cfg(target_os = "windows")]
extern "system" {
    fn GetDC(hwnd: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    fn ReleaseDC(hwnd: *mut core::ffi::c_void, hdc: *mut core::ffi::c_void) -> i32;
    fn GetSystemMetrics(index: i32) -> i32;
    fn GetWindowRect(hwnd: *mut core::ffi::c_void, rect: *mut Rect) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    fn DeleteDC(hdc: *mut core::ffi::c_void) -> i32;
    fn CreateCompatibleBitmap(
        hdc: *mut core::ffi::c_void,
        w: i32,
        h: i32,
    ) -> *mut core::ffi::c_void;
    fn DeleteObject(obj: *mut core::ffi::c_void) -> i32;
    fn SelectObject(
        hdc: *mut core::ffi::c_void,
        obj: *mut core::ffi::c_void,
    ) -> *mut core::ffi::c_void;
    fn BitBlt(
        hdc_dest: *mut core::ffi::c_void,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        hdc_src: *mut core::ffi::c_void,
        x_src: i32,
        y_src: i32,
        rop: u32,
    ) -> i32;
    fn GetDIBits(
        hdc: *mut core::ffi::c_void,
        hbitmap: *mut core::ffi::c_void,
        start: u32,
        lines: u32,
        bits: *mut core::ffi::c_void,
        info: *mut BitmapInfoHeaderOnly,
        usage: u32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
const SM_CXSCREEN: i32 = 0;
#[cfg(target_os = "windows")]
const SM_CYSCREEN: i32 = 1;
#[cfg(target_os = "windows")]
const SRCCOPY: u32 = 0x00CC_0020;
#[cfg(target_os = "windows")]
const DIB_RGB_COLORS: u32 = 0;
#[cfg(target_os = "windows")]
const BI_RGB: u32 = 0;

#[cfg(target_os = "windows")]
#[repr(C)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

// BITMAPINFOHEADER, straight layout, followed by nothing (BI_RGB has no
// color-table entries to append for a 32bpp bitmap) — named "...OnHeaderOnly"
// deliberately, so a reader doesn't go looking for a bmiColors tail that
// isn't here.
#[cfg(target_os = "windows")]
#[repr(C)]
struct BitmapInfoHeaderOnly {
    size: u32,
    width: i32,
    height: i32,
    planes: u16,
    bit_count: u16,
    compression: u32,
    size_image: u32,
    x_pels_per_meter: i32,
    y_pels_per_meter: i32,
    clr_used: u32,
    clr_important: u32,
}

#[cfg(target_os = "windows")]
struct ScopedDc {
    hwnd: *mut core::ffi::c_void,
    hdc: *mut core::ffi::c_void,
}

#[cfg(target_os = "windows")]
impl Drop for ScopedDc {
    fn drop(&mut self) {
        unsafe {
            ReleaseDC(self.hwnd, self.hdc);
        }
    }
}

/// `target`: "screen" captures the full primary display; anything else
/// (including "window") captures `hwnd`'s current client area.
pub fn capture(target: &str, hwnd: isize, out_path: &str) -> Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target, hwnd, out_path);
        Err(anyhow!(
            "screen capture not yet implemented on this platform"
        ))
    }

    #[cfg(target_os = "windows")]
    {
        unsafe {
            let capture_hwnd = if target == "screen" {
                core::ptr::null_mut()
            } else {
                hwnd as *mut core::ffi::c_void
            };

            let (width, height) = if target == "screen" {
                (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN))
            } else {
                let mut rect = Rect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                if GetWindowRect(capture_hwnd, &mut rect) == 0 {
                    return Err(anyhow!("GetWindowRect failed"));
                }
                (rect.right - rect.left, rect.bottom - rect.top)
            };
            if width <= 0 || height <= 0 {
                return Err(anyhow!("invalid capture dimensions {width}x{height}"));
            }

            let src_dc_raw = GetDC(capture_hwnd);
            if src_dc_raw.is_null() {
                return Err(anyhow!("GetDC failed"));
            }
            let src_dc = ScopedDc {
                hwnd: capture_hwnd,
                hdc: src_dc_raw,
            };

            let mem_dc = CreateCompatibleDC(src_dc.hdc);
            if mem_dc.is_null() {
                return Err(anyhow!("CreateCompatibleDC failed"));
            }
            let bitmap = CreateCompatibleBitmap(src_dc.hdc, width, height);
            if bitmap.is_null() {
                DeleteDC(mem_dc);
                return Err(anyhow!("CreateCompatibleBitmap failed"));
            }
            let old_obj = SelectObject(mem_dc, bitmap);

            let blt_ok = BitBlt(mem_dc, 0, 0, width, height, src_dc.hdc, 0, 0, SRCCOPY);
            if blt_ok == 0 {
                SelectObject(mem_dc, old_obj);
                DeleteObject(bitmap);
                DeleteDC(mem_dc);
                return Err(anyhow!("BitBlt failed"));
            }

            // Negative height requests a top-down DIB (row 0 first) —
            // otherwise GetDIBits hands back bottom-up rows, which would
            // need a manual flip before encoding.
            let mut header = BitmapInfoHeaderOnly {
                size: core::mem::size_of::<BitmapInfoHeaderOnly>() as u32,
                width,
                height: -height,
                planes: 1,
                bit_count: 32,
                compression: BI_RGB,
                size_image: 0,
                x_pels_per_meter: 0,
                y_pels_per_meter: 0,
                clr_used: 0,
                clr_important: 0,
            };
            let mut pixels = vec![0u8; (width as usize) * (height as usize) * 4];
            let got = GetDIBits(
                src_dc.hdc,
                bitmap,
                0,
                height as u32,
                pixels.as_mut_ptr() as *mut core::ffi::c_void,
                &mut header,
                DIB_RGB_COLORS,
            );

            SelectObject(mem_dc, old_obj);
            DeleteObject(bitmap);
            DeleteDC(mem_dc);

            if got == 0 {
                return Err(anyhow!("GetDIBits failed"));
            }

            // BGRA (GDI's native order) -> RGBA, in place.
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
            }

            let img: image::RgbaImage =
                image::ImageBuffer::from_raw(width as u32, height as u32, pixels)
                    .ok_or_else(|| anyhow!("pixel buffer size mismatch"))?;
            img.save(out_path)?;
            Ok(())
        }
    }
}
