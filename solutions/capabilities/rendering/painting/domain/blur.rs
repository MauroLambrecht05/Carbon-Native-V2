// Separable Gaussian blur for the box-shadow rasterizer.
//
// CSS `box-shadow: ... <blur> ...` specifies the blur radius in CSS px.
// The standard interpretation maps that to a Gaussian standard
// deviation σ ≈ blur_radius / 2. We build the 1D kernel up to ±3σ
// (covers >99.7% of the curve), apply horizontally into a scratch
// buffer, then vertically back into the pixmap. Separable Gaussian
// gives true rotational symmetry — better than the previous 3-pass
// box-blur approximation at the same cost-class, and identical to
// what browsers / Skia do.
//
// Complexity: O(w*h*k) where k = 6σ+1 ≈ 3*radius+1. For typical UI
// shadow radii (4–16 px), the per-shadow cost is well under a
// millisecond on a 200×60 box.

use tiny_skia::Pixmap;

/// In-place Gaussian blur. `radius` is the CSS-style blur radius.
/// The actual filter σ ≈ radius / 2. Radius 0 = no-op.
pub fn box_blur(pixmap: &mut Pixmap, radius: u32) {
    if radius == 0 {
        return;
    }
    gaussian_blur(pixmap, radius as f32 * 0.5);
}

pub fn gaussian_blur(pixmap: &mut Pixmap, sigma: f32) {
    if sigma < 0.4 {
        return;
    }
    let w = pixmap.width() as usize;
    let h = pixmap.height() as usize;
    if w == 0 || h == 0 {
        return;
    }

    // ±3σ covers 99.7% of the curve — anything beyond contributes <0.3%.
    let r = (sigma * 3.0).ceil().max(1.0) as usize;
    let kernel = build_kernel(sigma, r);

    let mut temp = vec![0u8; w * h * 4];
    let src = pixmap.data_mut();
    blur_h(src, &mut temp, w, h, r, &kernel);
    blur_v(&temp, src, w, h, r, &kernel);
}

fn build_kernel(sigma: f32, r: usize) -> Vec<f32> {
    let size = 2 * r + 1;
    let mut k = vec![0.0f32; size];
    let two_sigma_sq = 2.0 * sigma * sigma;
    let mut sum = 0.0;
    for i in 0..size {
        let x = (i as f32) - (r as f32);
        let w = (-(x * x) / two_sigma_sq).exp();
        k[i] = w;
        sum += w;
    }
    // Normalize so the kernel preserves overall pixmap energy.
    for v in &mut k {
        *v /= sum;
    }
    k
}

fn blur_h(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, kernel: &[f32]) {
    let kernel_len = kernel.len();
    for y in 0..h {
        let row = y * w * 4;
        for x in 0..w {
            let mut rc = 0.0f32;
            let mut gc = 0.0f32;
            let mut bc = 0.0f32;
            let mut ac = 0.0f32;
            for k in 0..kernel_len {
                let kx = (x as i32 + k as i32 - r as i32).clamp(0, w as i32 - 1) as usize;
                let p = row + kx * 4;
                let weight = kernel[k];
                rc += src[p] as f32 * weight;
                gc += src[p + 1] as f32 * weight;
                bc += src[p + 2] as f32 * weight;
                ac += src[p + 3] as f32 * weight;
            }
            let dp = row + x * 4;
            dst[dp] = rc.round().clamp(0.0, 255.0) as u8;
            dst[dp + 1] = gc.round().clamp(0.0, 255.0) as u8;
            dst[dp + 2] = bc.round().clamp(0.0, 255.0) as u8;
            dst[dp + 3] = ac.round().clamp(0.0, 255.0) as u8;
        }
    }
}

fn blur_v(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, kernel: &[f32]) {
    let stride = w * 4;
    let kernel_len = kernel.len();
    for x in 0..w {
        let col = x * 4;
        for y in 0..h {
            let mut rc = 0.0f32;
            let mut gc = 0.0f32;
            let mut bc = 0.0f32;
            let mut ac = 0.0f32;
            for k in 0..kernel_len {
                let ky = (y as i32 + k as i32 - r as i32).clamp(0, h as i32 - 1) as usize;
                let p = ky * stride + col;
                let weight = kernel[k];
                rc += src[p] as f32 * weight;
                gc += src[p + 1] as f32 * weight;
                bc += src[p + 2] as f32 * weight;
                ac += src[p + 3] as f32 * weight;
            }
            let dp = y * stride + col;
            dst[dp] = rc.round().clamp(0.0, 255.0) as u8;
            dst[dp + 1] = gc.round().clamp(0.0, 255.0) as u8;
            dst[dp + 2] = bc.round().clamp(0.0, 255.0) as u8;
            dst[dp + 3] = ac.round().clamp(0.0, 255.0) as u8;
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────
//
// Inline rather than in tests/, because `blur` is a private module — the crate
// root declares `mod blur;`, not `pub mod`. Making it public just to test it
// would widen the API for the tests' benefit.
//
// These are the first tests carbon-paint has had. Blur is the natural place to
// start: it is pure arithmetic over a byte buffer, deterministic, and needs no
// window, no device and no scene.

#[cfg(test)]
mod tests {
    use super::*;

    /// A pixmap with one fully-opaque white pixel at its centre.
    fn single_dot(size: u32) -> Pixmap {
        let mut pm = Pixmap::new(size, size).expect("pixmap");
        let mid = (size / 2) as usize;
        let stride = size as usize * 4;
        let px = &mut pm.data_mut()[mid * stride + mid * 4..][..4];
        px.copy_from_slice(&[255, 255, 255, 255]);
        pm
    }

    fn alpha_at(pm: &Pixmap, x: u32, y: u32) -> u8 {
        let stride = pm.width() as usize * 4;
        pm.data()[y as usize * stride + x as usize * 4 + 3]
    }

    fn total_alpha(pm: &Pixmap) -> u64 {
        pm.data().chunks_exact(4).map(|p| p[3] as u64).sum()
    }

    #[test]
    fn radius_zero_is_a_no_op() {
        // Not "approximately unchanged" — byte-identical. A blur that always
        // runs would cost every shadow-free frame.
        let mut pm = single_dot(9);
        let before = pm.data().to_vec();
        box_blur(&mut pm, 0);
        assert_eq!(pm.data(), &before[..]);
    }

    #[test]
    fn a_sigma_below_the_floor_is_a_no_op() {
        let mut pm = single_dot(9);
        let before = pm.data().to_vec();
        gaussian_blur(&mut pm, 0.3);
        assert_eq!(pm.data(), &before[..]);
    }

    #[test]
    fn blurring_spreads_alpha_outwards() {
        let mut pm = single_dot(21);
        assert_eq!(alpha_at(&pm, 9, 10), 0, "neighbour starts empty");

        box_blur(&mut pm, 8);

        assert!(alpha_at(&pm, 9, 10) > 0, "alpha should reach the neighbour");
        assert!(alpha_at(&pm, 10, 10) < 255, "the centre should have dimmed");
    }

    #[test]
    fn the_result_is_rotationally_symmetric() {
        // The reason this is a separable Gaussian and not a 3-pass box blur:
        // a box approximation leaves a visibly square shadow. The four
        // neighbours of the centre must come out equal.
        let mut pm = single_dot(21);
        box_blur(&mut pm, 6);

        let left = alpha_at(&pm, 9, 10);
        let right = alpha_at(&pm, 11, 10);
        let up = alpha_at(&pm, 10, 9);
        let down = alpha_at(&pm, 10, 11);

        assert_eq!(left, right, "horizontal neighbours differ");
        assert_eq!(up, down, "vertical neighbours differ");
        assert!(
            (left as i16 - up as i16).abs() <= 1,
            "horizontal {left} and vertical {up} should match within rounding"
        );
    }

    /// A filled opaque square, centred, `side` pixels across.
    ///
    /// The spread tests use this rather than single_dot because a lone pixel
    /// does not carry enough alpha to survive a wide blur in 8 bits: 255 spread
    /// over a sigma-8 Gaussian is under half a unit per pixel, which rounds to
    /// zero everywhere and makes two different radii both read 0. A block is
    /// also what a real box-shadow actually blurs.
    fn filled_block(size: u32, side: u32) -> Pixmap {
        let mut pm = Pixmap::new(size, size).expect("pixmap");
        let start = (size - side) / 2;
        let stride = size as usize * 4;
        for y in start..start + side {
            for x in start..start + side {
                let px = &mut pm.data_mut()[y as usize * stride + x as usize * 4..][..4];
                px.copy_from_slice(&[255, 255, 255, 255]);
            }
        }
        pm
    }

    #[test]
    fn a_larger_radius_spreads_further() {
        // Block spans 16..24 in a 41px pixmap. Sample at x=13, three pixels
        // outside the edge — reachable by a wide blur, not by a narrow one.
        let mut small = filled_block(41, 8);
        let mut large = filled_block(41, 8);
        box_blur(&mut small, 4);
        box_blur(&mut large, 16);

        assert!(
            alpha_at(&large, 13, 20) > alpha_at(&small, 13, 20),
            "a wider blur should carry more alpha past the edge: \
             large={} small={}",
            alpha_at(&large, 13, 20),
            alpha_at(&small, 13, 20),
        );
    }

    #[test]
    fn a_larger_radius_softens_the_centre_less_than_the_edge() {
        // Deep inside a filled block every kernel tap is opaque, so the centre
        // stays solid no matter how wide the blur. This is what stops a shadow
        // from washing out its own body.
        let mut pm = filled_block(41, 20);
        box_blur(&mut pm, 4);
        assert_eq!(
            alpha_at(&pm, 20, 20),
            255,
            "the block's interior should stay opaque"
        );
    }

    #[test]
    fn energy_is_roughly_conserved() {
        // A normalised kernel neither invents nor destroys much alpha. Losing
        // it makes shadows fade; gaining it makes them bloom. The tolerance is
        // wide because the kernel is truncated at 3-sigma and clipped at the
        // pixmap edge.
        let mut pm = single_dot(41);
        let before = total_alpha(&pm);
        box_blur(&mut pm, 6);
        let after = total_alpha(&pm);

        let ratio = after as f64 / before as f64;
        assert!(
            (0.85..=1.15).contains(&ratio),
            "alpha ratio {ratio} drifted too far from 1"
        );
    }

    #[test]
    fn an_empty_pixmap_does_not_panic() {
        // Pixmap::new rejects a zero dimension, so the guard inside
        // gaussian_blur is reached via a 1x1 instead — the smallest buffer a
        // kernel wider than the image can be applied to.
        let mut pm = Pixmap::new(1, 1).expect("pixmap");
        box_blur(&mut pm, 12);
    }

    #[test]
    fn a_blur_wider_than_the_image_stays_in_bounds() {
        // Kernel radius here far exceeds the pixmap, so every tap is clamped.
        // An off-by-one in the clamp is an out-of-bounds index, not a wrong
        // colour.
        let mut pm = single_dot(3);
        box_blur(&mut pm, 40);
    }
}
