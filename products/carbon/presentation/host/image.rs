// async_image.rs — HTTP(S) image loader for `background-image: url(...)`.
//
// The synchronous local-file image cache in `paint::get_image` handles
// PNG on disk. For URL-style sources we need an async path: spawn a
// reqwest GET on the shared tokio runtime, decode the bytes, stash the
// resulting Pixmap into a global cache, and post `UserEvent::RequestPaint`
// so the next frame picks it up.
//
// The cache is a Mutex<HashMap<url, State>> where State is one of:
//   - Loading: fetch in flight; don't kick off another
//   - Ready(Pixmap): decoded, ready to blit
//   - Failed: fetch or decode errored; cache the failure so we don't retry
//             forever on every frame
//
// Decode path:
//   - PNG: tiny_skia::Pixmap::decode_png (no extra deps; png-format
//     feature is already on in Cargo.toml)
//   - Other formats (JPEG, WebP, GIF): only when the `image` feature is
//     enabled, decoded via carbon-image's `decoder::decode_bytes` and
//     copied into a fresh Pixmap. Without the feature, those URLs fail
//     and the user gets a cleared box.
//
// Triggered from paint::get_image when it sees an http:// or https://
// prefix.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tiny_skia::Pixmap;

use crate::native::net::{http_client, post, rt};
use crate::UserEvent;

enum State {
    Loading,
    Ready(Pixmap),
    Failed,
}

fn cache() -> &'static Mutex<HashMap<String, State>> {
    static C: OnceLock<Mutex<HashMap<String, State>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a URL to a cached Pixmap if ready. Returns None for
/// in-flight or failed loads. The first call with a fresh URL kicks
/// off a background fetch, then returns None — the paint that triggered
/// the request will repaint when the fetch completes and the entry
/// flips to Ready.
///
/// Special-cases `data:image/svg+xml,…` (the form every npm icon pack
/// uses for inline icons) by decoding synchronously into a Pixmap via
/// resvg — no async fetch, ready on the same frame.
pub fn get(url: &str) -> Option<Pixmap> {
    {
        let guard = cache().lock().unwrap_or_else(|e| e.into_inner());
        match guard.get(url) {
            Some(State::Ready(pm)) => return Some(pm.clone()),
            // Loading or Failed: don't kick off another fetch.
            Some(_) => return None,
            None => {}
        }
    }

    // Data-URL path — sync, no background spawn. SVG is by far the most
    // common payload here (catppuccin/lucide/heroicons inline icons);
    // raster data: URLs fall through to decode_bytes which handles
    // base64-PNG/JPEG inline images too.
    if let Some(rest) = url.strip_prefix("data:") {
        let pm = decode_data_url(rest);
        let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
        match pm {
            Ok(p) => {
                guard.insert(url.to_string(), State::Ready(p.clone()));
                return Some(p);
            }
            Err(msg) => {
                eprintln!("[carbon-mini] data: URL decode failed: {msg}");
                guard.insert(url.to_string(), State::Failed);
                return None;
            }
        }
    }

    // Mark as loading BEFORE spawn so a second paint that happens in
    // the same tick doesn't double-fire.
    {
        let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(url.to_string(), State::Loading);
    }
    spawn_fetch(url.to_string());
    None
}

fn spawn_fetch(url: String) {
    rt().spawn(async move {
        let result = fetch_and_decode(&url).await;
        {
            let mut guard = cache().lock().unwrap_or_else(|e| e.into_inner());
            match result {
                Ok(pm) => {
                    guard.insert(url.clone(), State::Ready(pm));
                }
                Err(msg) => {
                    eprintln!("[carbon-mini] image fetch '{}' failed: {}", url, msg);
                    guard.insert(url.clone(), State::Failed);
                }
            }
        }
        // Wake the event loop so the new pixmap shows up next frame.
        post(UserEvent::RequestPaint);
    });
}

async fn fetch_and_decode(url: &str) -> Result<Pixmap, String> {
    let resp = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("status {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
    decode_bytes(&bytes)
}

fn decode_bytes(bytes: &[u8]) -> Result<Pixmap, String> {
    // Try tiny-skia's PNG decoder first — zero extra deps, covers the
    // common logo/icon case. PNG detection is implicit; tiny-skia
    // returns an error for non-PNG bytes and we fall through.
    if let Ok(pm) = Pixmap::decode_png(bytes) {
        return Ok(pm);
    }
    decode_non_png(bytes)
}

#[cfg(feature = "image")]
fn decode_non_png(bytes: &[u8]) -> Result<Pixmap, String> {
    use carbon_image::decoder::decode_bytes as decode;
    let img = decode(bytes).map_err(|e| format!("decode: {e}"))?;
    let mut pm = Pixmap::new(img.width, img.height)
        .ok_or_else(|| format!("pixmap alloc {}x{}", img.width, img.height))?;
    let dst = pm.data_mut();
    if dst.len() != img.bytes.len() {
        return Err(format!(
            "rgba8 size mismatch dst={} src={}",
            dst.len(),
            img.bytes.len()
        ));
    }
    dst.copy_from_slice(&img.bytes);
    Ok(pm)
}

#[cfg(not(feature = "image"))]
fn decode_non_png(_bytes: &[u8]) -> Result<Pixmap, String> {
    Err(
        "non-PNG remote images require the 'image' feature \
         (carbon.toml: [runtime] image = true)"
            .to_string(),
    )
}

/// Parse the `<media-type>[;base64],<payload>` body of a data: URL into
/// a Pixmap. Branches on media type: SVG goes through resvg, everything
/// else through the raster decoder.
fn decode_data_url(after_data: &str) -> Result<Pixmap, String> {
    // Split media + payload at the first comma. Per RFC 2397 the comma is
    // the only required delimiter; everything before it is metadata.
    let comma = after_data
        .find(',')
        .ok_or_else(|| "data URL missing comma separator".to_string())?;
    let meta = &after_data[..comma];
    let payload = &after_data[comma + 1..];
    let is_base64 = meta.ends_with(";base64");
    let media_type = meta.split(';').next().unwrap_or("");

    if media_type == "image/svg+xml" {
        // SVG payloads are typically percent-encoded plain text. Base64
        // SVG also exists (some encoders default to it for safety) — try
        // both routes.
        let svg_text: String = if is_base64 {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload.trim())
                .map_err(|e| format!("svg base64: {e}"))?;
            String::from_utf8(bytes).map_err(|e| format!("svg utf8: {e}"))?
        } else {
            // percent-decode — only `%` sequences need handling; raw
            // characters pass through as-is.
            percent_decode(payload)
        };
        return rasterise_svg(&svg_text);
    }

    // Raster path: bytes → existing decode_bytes pipeline.
    let bytes: Vec<u8> = if is_base64 {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(payload.trim())
            .map_err(|e| format!("base64: {e}"))?
    } else {
        percent_decode(payload).into_bytes()
    };
    decode_bytes(&bytes)
}

/// Inline-SVG-to-Pixmap. Picks a sensible output size from the SVG's own
/// viewBox / width / height. We don't yet know the layout box the image
/// will eventually paint into (that's a paint-time concern), so we
/// pre-rasterise at the intrinsic size — tiny-skia stretches it to the
/// box via its existing nearest-neighbor scale in the paint pipeline.
fn rasterise_svg(svg: &str) -> Result<Pixmap, String> {
    let opts = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg, &opts).map_err(|e| format!("svg parse: {e}"))?;
    let size = tree.size();
    // Cap output dimensions so an icon pack that ships viewBox="0 0 4096 4096"
    // doesn't allocate 64 MB. 256 px is plenty for any icon use case;
    // larger SVGs (illustrations, posters) should use a higher cap if
    // they appear in real apps — revisit then.
    const MAX_DIM: f32 = 256.0;
    let intrinsic_w = size.width();
    let intrinsic_h = size.height();
    let max_intrinsic = intrinsic_w.max(intrinsic_h).max(1.0);
    let scale = if max_intrinsic > MAX_DIM {
        MAX_DIM / max_intrinsic
    } else {
        1.0
    };
    let out_w = ((intrinsic_w * scale).ceil() as u32).max(1);
    let out_h = ((intrinsic_h * scale).ceil() as u32).max(1);
    let mut pm =
        Pixmap::new(out_w, out_h).ok_or_else(|| format!("pixmap alloc {out_w}x{out_h}"))?;
    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pm.as_mut());
    Ok(pm)
}

/// Tiny percent-decoder. data: URLs commonly use it for SVG content
/// (`%3Csvg%20…`). We avoid pulling in the `percent-encoding` crate —
/// the format is trivial: '%XX' → byte. Invalid sequences pass through
/// literally so the SVG parser gets the chance to error meaningfully.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        // '+' is sometimes used for space in URL form-encoding; tolerate
        // it the same way browsers do for data: URLs (they don't, but
        // it's a frequent encoder bug).
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
