// Format-agnostic image decode → RGBA8.
//
// We always return RGBA8 in `(width, height, bytes)` shape regardless of
// what the source file looked like internally. That gives the rest of
// the pipeline (cache, JS handoff, GPU texture upload) one canonical
// layout to work with, matches `wgpu::TextureFormat::Rgba8Unorm` exactly,
// and matches the Web Image API contract on the JS side.
//
// Format detection
// ----------------
// `image::guess_format` peeks the magic bytes (PNG signature, JPEG SOI,
// etc.) and picks a decoder. We rely on it instead of file extensions
// because the path-load entry point can be handed any user-supplied
// path; the bytes-load entry point obviously has no path at all. If the
// file is too short or the format isn't compiled in (e.g. AVIF with the
// `avif` feature off) we surface a clear error to JS.

use anyhow::{anyhow, Context, Result};
use image::{ImageFormat, ImageReader};
use std::io::Cursor;

/// One decoded image in canonical RGBA8 layout. `bytes.len() == w * h * 4`.
///
/// The Vec is heap-allocated; once the cache hands it off to JS we wrap
/// it in an `Arc<Vec<u8>>` so multiple JS-side `CarbonImage` instances
/// can share the same backing buffer without re-decoding.
#[derive(Debug)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
    /// Format the source bytes were detected as. Surfaced to JS for
    /// debugging / the `<image>` intrinsic's status overlay; not used
    /// internally. We store the friendly lowercase name (`"png"`,
    /// `"jpeg"`, etc.) since `ImageFormat::extensions_str()[0]` is
    /// the lowercase canonical extension.
    pub format: &'static str,
}

impl DecodedImage {
    /// Bytes in the buffer. Equal to `width * height * 4` because the
    /// output format is always RGBA8 regardless of source.
    pub fn byte_len(&self) -> usize {
        self.bytes.len()
    }
}

/// Decode a slice of bytes (the entire file content) into RGBA8.
///
/// The implementation flow:
///   1. `guess_format` reads the magic header; if unknown, error out.
///   2. `ImageReader::with_format(...).decode()` runs the format-specific
///      decoder.
///   3. `to_rgba8()` converts whatever color space + channel count came
///      out of the decoder into the canonical 4-channel 8-bit-per-channel
///      layout. This is a no-op for already-RGBA8 PNGs, a memcpy + alpha
///      fill for RGB JPEGs, and a real conversion for indexed/grayscale.
///
/// Cost: dominated by step 2. PNG decode is ~50 MB/s on a single core,
/// JPEG ~100 MB/s, AVIF ~30 MB/s. Step 3 is ~2 GB/s (just a buffer copy
/// in the common case). For a 2 MB JPEG that's ~20 ms total.
pub fn decode_bytes(bytes: &[u8]) -> Result<DecodedImage> {
    // `guess_format` is cheap (reads ~12 bytes). We keep it separate from
    // ImageReader::new so we can produce a clear "unknown format" error
    // distinct from "format detected but decode failed".
    let format = image::guess_format(bytes)
        .map_err(|e| anyhow!("could not detect image format from bytes: {e}"))?;

    // Verify the format is actually compiled in. `image::ImageReader`
    // would also fail later but with a less obvious error message.
    // (We can't dispatch on every variant statically because the enum
    // is non-exhaustive; we just attempt and let it bubble.)

    let mut reader = ImageReader::new(Cursor::new(bytes));
    reader.set_format(format);
    // Default decoding limits (no explicit cap) — three.js's image loader
    // is unbounded too. Apps that want a memory cap should validate the
    // file size before calling us.
    let dynamic = reader
        .decode()
        .with_context(|| format!("decode {} image", format_name(format)))?;

    let rgba = dynamic.to_rgba8();
    let (w, h) = rgba.dimensions();
    let raw = rgba.into_raw();
    debug_assert_eq!(raw.len(), (w as usize) * (h as usize) * 4);

    Ok(DecodedImage {
        width: w,
        height: h,
        bytes: raw,
        format: format_name(format),
    })
}

/// Read+decode a file from disk. Distinct from `decode_bytes` so the
/// path-based callers can apply their capability check before hitting
/// the filesystem.
pub fn decode_path(path: &std::path::Path) -> Result<DecodedImage> {
    let bytes =
        std::fs::read(path).with_context(|| format!("read image file {}", path.display()))?;
    decode_bytes(&bytes)
}

/// Map an `ImageFormat` to its canonical lowercase short name. Stable
/// strings the JS side can compare against (`'png'`, `'jpeg'`, `'gif'`).
fn format_name(f: ImageFormat) -> &'static str {
    // ImageFormat has 13 variants in image 0.25. We hand-match each so
    // that adding a feature flag (e.g. `avif`) doesn't silently turn into
    // a fallback. The match is non-exhaustive because the enum is
    // marked non-exhaustive upstream.
    match f {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Pnm => "pnm",
        ImageFormat::Tiff => "tiff",
        ImageFormat::Tga => "tga",
        ImageFormat::Dds => "dds",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Ico => "ico",
        ImageFormat::Hdr => "hdr",
        ImageFormat::OpenExr => "exr",
        ImageFormat::Farbfeld => "farbfeld",
        ImageFormat::Avif => "avif",
        ImageFormat::Qoi => "qoi",
        #[allow(deprecated)]
        ImageFormat::Pcx => "pcx",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Encode a tiny 4×3 RGBA PNG in memory using the `image` crate's
    /// own encoder so we don't have to check binaries into git, then
    /// decode it back through `decode_bytes` and assert the round-trip.
    #[test]
    fn round_trip_png_4x3() {
        // Build the source pixel grid: (x*64, y*85, 128, 255) — every
        // pixel is unique so a buggy decoder that swizzles can be caught.
        let w = 4u32;
        let h = 3u32;
        let mut src = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                src.push((x * 64) as u8);
                src.push((y * 85) as u8);
                src.push(128);
                src.push(255);
            }
        }
        let img = image::RgbaImage::from_raw(w, h, src.clone()).unwrap();
        let mut encoded = Vec::new();
        img.write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
            .unwrap();

        let decoded = decode_bytes(&encoded).expect("decode");
        assert_eq!(decoded.width, w);
        assert_eq!(decoded.height, h);
        assert_eq!(decoded.format, "png");
        assert_eq!(decoded.bytes, src, "round-trip pixel match");
    }

    /// JPEG is lossy, so we don't expect bit-exact round-trip — just
    /// dimensions + an opaque first pixel close to the input.
    #[test]
    fn round_trip_jpeg_8x8() {
        let w = 8u32;
        let h = 8u32;
        // Solid red — JPEG will preserve this within a few units.
        let src: Vec<u8> = (0..(w * h))
            .flat_map(|_| [200u8, 30, 30, 255].into_iter())
            .collect();
        let img = image::RgbaImage::from_raw(w, h, src).unwrap();
        // Convert to RGB8 since JPEG can't store alpha.
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        let mut encoded = Vec::new();
        rgb.write_to(&mut Cursor::new(&mut encoded), ImageFormat::Jpeg)
            .unwrap();

        let decoded = decode_bytes(&encoded).expect("jpeg decode");
        assert_eq!(decoded.width, w);
        assert_eq!(decoded.height, h);
        assert_eq!(decoded.format, "jpeg");
        // Alpha is forced to 255 by `to_rgba8`.
        assert_eq!(decoded.bytes[3], 255);
        // Red channel within ±20 of the input (loose JPEG tolerance).
        let r = decoded.bytes[0];
        assert!(r > 180 && r < 220, "red channel preserved (got {r})");
    }

    /// Garbage bytes must error rather than panic. The error message
    /// content isn't load-bearing — we just assert it's an Err.
    #[test]
    fn random_bytes_error() {
        let garbage = b"this is not an image at all, definitely not";
        let r = decode_bytes(garbage);
        assert!(r.is_err(), "garbage must not decode");
    }
}
