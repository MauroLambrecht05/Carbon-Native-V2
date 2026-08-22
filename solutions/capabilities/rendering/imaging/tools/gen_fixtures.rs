// gen_fixtures — generate test PNG/JPEG/WebP files for use in tests and examples.
// Run with: cargo run --bin gen_fixtures

use image::{RgbImage, RgbaImage};

fn main() {
    // cargo test-fixtures directory
    let base = std::env::var("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let fixtures = base.join("test-fixtures");
    std::fs::create_dir_all(&fixtures).unwrap();

    // Also write to image-viewer/assets if it exists.
    let example_assets = base
        .parent()
        .unwrap() // packages/
        .parent()
        .unwrap() // carbon-native/
        .join("examples/image-viewer/assets");
    let example_exists = example_assets.exists();

    // ── 100×100 gradient PNG ──────────────────────────────────────────
    {
        let w = 100u32;
        let h = 100u32;
        let pixels: Vec<u8> = (0..(w * h))
            .flat_map(|i| {
                let x = (i % w) as u8;
                let y = (i / w) as u8;
                [x.wrapping_mul(2), y.wrapping_mul(2), 128u8, 255u8]
            })
            .collect();
        let img = RgbaImage::from_raw(w, h, pixels).unwrap();
        let path = fixtures.join("test.png");
        img.save(&path).unwrap();
        println!("Wrote {}", path.display());
        if example_exists {
            img.save(example_assets.join("test.png")).unwrap();
            println!("Wrote {}", example_assets.join("test.png").display());
        }
    }

    // ── 100×100 solid-color JPEG ──────────────────────────────────────
    {
        let w = 100u32;
        let h = 100u32;
        let pixels: Vec<u8> = (0..(w * h))
            .flat_map(|i| {
                let x = (i % w) as u8;
                let y = (i / w) as u8;
                [x, 100u8, y]
            })
            .collect();
        let img = RgbImage::from_raw(w, h, pixels).unwrap();
        let path = fixtures.join("test.jpg");
        img.save(&path).unwrap();
        println!("Wrote {}", path.display());
        if example_exists {
            img.save(example_assets.join("test.jpg")).unwrap();
            println!("Wrote {}", example_assets.join("test.jpg").display());
        }
    }

    // ── 50×50 solid WebP (if webp feature is enabled) ─────────────────
    #[cfg(feature = "webp")]
    {
        let w = 50u32;
        let h = 50u32;
        let pixels: Vec<u8> = (0..(w * h)).flat_map(|_| [0u8, 128, 255, 255]).collect();
        let img = RgbaImage::from_raw(w, h, pixels).unwrap();
        let path = fixtures.join("test.webp");
        img.save(&path).unwrap();
        println!("Wrote {}", path.display());
    }

    println!("Done.");
}
