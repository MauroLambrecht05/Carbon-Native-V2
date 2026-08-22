// gpu.rs — Phase 1 GPU canvas foundation for carbon-mini.
//
// Some of the public API below (`width`, `height`, `execute_commands`,
// `DrawCommand`, `is_initialized`) is intentionally not consumed by
// Phase 1's main.rs — these are the surface that Phase 2's three.js
// renderer + the bench/test harness will consume.

#![allow(dead_code)]

//
// Goals (locked in docs/GPU_PLAN.md):
//   * **Lazy init** — UI-only apps must pay 0 ms cold-start cost. The wgpu
//     instance/adapter/device are only constructed on the first
//     <canvas> intrinsic creation. We use OnceLock for thread-safe
//     once-only init of a process-global Gpu handle.
//   * **No present-path change** — wgpu renders to an offscreen RGBA
//     texture. Each frame, the scene rasterizer reads back the texture
//     pixels via a COPY_SRC -> mappable buffer round-trip and tiny-skia
//     blits them into the existing softbuffer pixmap. The window's
//     swapchain is still owned exclusively by softbuffer.
//   * **Windows D3D12 first** — Cargo.toml selects only the dx12 wgpu
//     backend. We don't request Vulkan/GL/Metal for Phase 1.
//   * **Phase-2 hook** — `execute_commands(&[DrawCommand])` is the
//     interface a future three.js renderer will produce against. For
//     Phase 1 the only command is `DrawCommand::Clear { rgba }`.
//
// Cost notes (instrumented in `read_pixels`):
//   * Per-frame readback: copy_texture_to_buffer + buffer.map + memcpy.
//     At 1080p that's ~8 MB; on a typical laptop iGPU the round-trip is
//     ~1–2 ms (PCIe + driver synchronization). Phase 1 budget allows it.
//   * If the canvas size doesn't change, we re-use the readback buffer
//     to avoid re-allocating each frame.

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use crate::executor::CanvasExecutor;

/// Global lazy-initialized GPU handle. None until the first call to
/// `Gpu::get()`. `OnceLock` is used so concurrent first-callers serialize
/// on init without a `Mutex` round-trip after init.
static GPU: OnceLock<Gpu> = OnceLock::new();

/// Process-wide registry of `CanvasSurface` keyed by JS-visible id.
/// We hand JS an integer (the id) instead of a Rust pointer so the
/// scene graph can refer to canvases without owning them, and so JS
/// can call __carbon_canvas_* with a stable handle.
static REGISTRY: OnceLock<Mutex<CanvasRegistry>> = OnceLock::new();

fn registry() -> &'static Mutex<CanvasRegistry> {
    REGISTRY.get_or_init(|| Mutex::new(CanvasRegistry::default()))
}

#[derive(Default)]
struct CanvasRegistry {
    surfaces: HashMap<u32, CanvasSurface>,
    /// Per-canvas GPU executor. Lazy-initialized on the first
    /// __carbon_canvas_execute_commands call for that canvas. Kept
    /// separate from the surface so existing test paths that only call
    /// `clear` / `read_pixels` still work without ever building one.
    executors: HashMap<u32, CanvasExecutor>,
    next_id: u32,
}

/// Owned by the `OnceLock`; cheap to clone-by-reference (each field is
/// already `Arc`-like under the hood from wgpu).
pub struct Gpu {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
}

impl Gpu {
    /// Lazy entry point. First call creates the device on the calling
    /// thread (~50–150 ms on Windows for D3D12). Subsequent calls hit
    /// the OnceLock fast path (atomic load, no contention).
    pub fn get() -> Result<&'static Gpu> {
        if let Some(g) = GPU.get() {
            return Ok(g);
        }
        // OnceLock::get_or_init can't return a Result, so we eagerly
        // construct and bubble-up panics into a Result via init_lazy.
        let gpu = Self::init_lazy()?;
        // `set` errors only if another thread initialized in the
        // meantime — that's fine, just use whatever's there.
        let _ = GPU.set(gpu);
        Ok(GPU.get().expect("GPU initialized"))
    }

    /// Build the wgpu instance/adapter/device. Logged with timing if
    /// CARBON_MINI_TIMING=1 so the bench harness can see init cost.
    fn init_lazy() -> Result<Gpu> {
        let t0 = Instant::now();
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            // Only DX12 — keeps the loader cost down. Vulkan+GL backends
            // are not compiled in (see Cargo.toml feature flags).
            backends: wgpu::Backends::DX12,
            backend_options: wgpu::BackendOptions::default(),
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        });

        // request_adapter is async but typically resolves in <1ms once the
        // backend is loaded. pollster::block_on with a noop waker is fine.
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        }))
        .map_err(|e| anyhow!("wgpu request_adapter failed: {e:?}"))?;

        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("carbon-mini-gpu"),
            required_features: wgpu::Features::empty(),
            // Conservative limits — we're targeting offscreen
            // canvases up to ~4k². Defaults already cover this and
            // are what the docs recommend for "broad compat".
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::default(),
            trace: wgpu::Trace::Off,
            experimental_features: wgpu::ExperimentalFeatures::default(),
        }))
        .map_err(|e| anyhow!("wgpu request_device failed: {e:?}"))?;

        if std::env::var_os("CARBON_MINI_TIMING").is_some() {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            eprintln!("[carbon-mini-timing] phase=gpu_init_lazy elapsed_ms={ms:.2}");
        }
        Ok(Gpu {
            instance,
            adapter,
            device,
            queue,
        })
    }
}

/// A single drawable RGBA8 offscreen texture, plus a readback buffer
/// sized to it. Phase 1 surfaces are CPU-readable each frame so the
/// existing tiny-skia present path can blit them; that's the whole
/// point of the "non-invasive composite" approach in the GPU plan.
pub struct CanvasSurface {
    width: u32,
    height: u32,
    /// `RENDER_ATTACHMENT | COPY_SRC` — used as a render target then
    /// copied out to `readback`. We don't sample from it on the GPU.
    texture: wgpu::Texture,
    /// Last submitted clear color (stored so the rasterizer can paint
    /// the surface even before the JS side issues any draw commands —
    /// keeps the path deterministic between frames).
    last_rgba: [u8; 4],
    /// Mappable buffer big enough for one full readback. Reused while
    /// width/height are stable. wgpu requires bytes_per_row aligned to
    /// 256, so we pad here and unpad in `read_pixels`.
    readback: wgpu::Buffer,
    padded_bytes_per_row: u32,
    /// Last-known unpadded RGBA8 pixel grid. We keep the latest copy
    /// in-process because reading back every frame even when nothing
    /// has changed still costs ~1 ms — this lets the rasterizer skip
    /// readback when the canvas hasn't been redrawn since last paint.
    pub last_pixels: Vec<u8>,
    /// Set on every draw; cleared by `take_dirty()` when the rasterizer
    /// has consumed the readback. Used for the "skip readback when
    /// nothing changed" optimization above.
    dirty: bool,
}

impl CanvasSurface {
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Self {
        let (w, h) = clamp_size(width, height);
        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("carbon-canvas-surface"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // RGBA8 unorm — matches what tiny-skia expects after we
            // swizzle to its premultiplied BGRA layout in scene.rs.
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let (readback, padded_bytes_per_row) = make_readback(gpu, w, h);
        Self {
            width: w,
            height: h,
            texture,
            last_rgba: [0, 0, 0, 0],
            readback,
            padded_bytes_per_row,
            last_pixels: vec![0u8; (w as usize) * (h as usize) * 4],
            dirty: true,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }

    /// View into the surface's color texture, used by the executor as a render
    /// pass attachment. `&Self` because TextureView creation is read-only.
    pub fn texture_view(&self) -> wgpu::TextureView {
        self.texture
            .create_view(&wgpu::TextureViewDescriptor::default())
    }

    /// Used by the executor after submitting GPU work, so the next paint
    /// triggers a readback. The existing `clear` path also marks dirty.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// Resize the offscreen texture and readback buffer. No-op if the
    /// requested size matches the current size.
    pub fn resize(&mut self, gpu: &Gpu, width: u32, height: u32) {
        let (w, h) = clamp_size(width, height);
        if w == self.width && h == self.height {
            return;
        }
        self.texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("carbon-canvas-surface"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let (rb, padded) = make_readback(gpu, w, h);
        self.readback = rb;
        self.padded_bytes_per_row = padded;
        self.last_pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        self.width = w;
        self.height = h;
        self.dirty = true;
    }

    /// Render-pass clear-and-submit. RGBA in [0..1] floats so we don't
    /// need any conversion on the GPU.
    pub fn clear(&mut self, gpu: &Gpu, r: f32, g: f32, b: f32, a: f32) {
        let view = self
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("carbon-canvas-clear"),
            });
        {
            let _rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("carbon-canvas-clear-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: r as f64,
                            g: g as f64,
                            b: b as f64,
                            a: a as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }
        gpu.queue.submit(Some(encoder.finish()));
        self.last_rgba = [
            (r.clamp(0.0, 1.0) * 255.0).round() as u8,
            (g.clamp(0.0, 1.0) * 255.0).round() as u8,
            (b.clamp(0.0, 1.0) * 255.0).round() as u8,
            (a.clamp(0.0, 1.0) * 255.0).round() as u8,
        ];
        self.dirty = true;
    }

    /// Copy the texture into the readback buffer, map+read it, and
    /// return RGBA8 pixels with no row padding. Updates `last_pixels`.
    ///
    /// Cost: one queue submit, one buffer.map + poll, one memcpy of
    /// (w * h * 4) bytes plus a row-by-row unpad if width*4 isn't
    /// 256-byte aligned. ~1 ms at 400×300, ~2 ms at 1080p on iGPU.
    pub fn read_pixels(&mut self, gpu: &Gpu) -> &[u8] {
        if !self.dirty {
            return &self.last_pixels;
        }
        let t0 = Instant::now();

        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("carbon-canvas-readback"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bytes_per_row),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );
        gpu.queue.submit(Some(encoder.finish()));

        // Map and synchronously poll until ready. wgpu schedules the map
        // callback for after the previous queue.submit completes; we just
        // need to drive the device until it does.
        let slice = self.readback.slice(..);
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        slice.map_async(wgpu::MapMode::Read, move |res| {
            let _ = tx.send(res);
        });
        // poll() drives the GPU; Wait blocks until everything submitted
        // before this call has finished.
        let _ = gpu.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: None,
        });
        let _ = rx.recv().expect("map_async sender dropped");
        let mapped = slice.get_mapped_range();

        let unpadded_bpr = (self.width as usize) * 4;
        let padded_bpr = self.padded_bytes_per_row as usize;
        if unpadded_bpr == padded_bpr {
            self.last_pixels.copy_from_slice(&mapped[..]);
        } else {
            for row in 0..(self.height as usize) {
                let src_off = row * padded_bpr;
                let dst_off = row * unpadded_bpr;
                self.last_pixels[dst_off..dst_off + unpadded_bpr]
                    .copy_from_slice(&mapped[src_off..src_off + unpadded_bpr]);
            }
        }
        drop(mapped);
        self.readback.unmap();
        self.dirty = false;

        if std::env::var_os("CARBON_MINI_TIMING").is_some() {
            let ms = t0.elapsed().as_secs_f64() * 1000.0;
            eprintln!(
                "[carbon-mini-timing] phase=gpu_readback w={} h={} elapsed_ms={ms:.2}",
                self.width, self.height
            );
        }
        &self.last_pixels
    }

    /// Phase-2 hook: a list of draw commands produced by an external
    /// renderer (e.g. a custom three.js bridge) is executed against
    /// this surface in submission order. Phase 1 handles only `Clear`.
    pub fn execute_commands(&mut self, gpu: &Gpu, cmds: &[DrawCommand]) {
        for cmd in cmds {
            match cmd {
                DrawCommand::Clear { rgba } => {
                    self.clear(gpu, rgba[0], rgba[1], rgba[2], rgba[3]);
                }
            }
        }
    }
}

/// The Phase-1 draw command vocabulary. Phase 2 will extend this with
/// concrete draw calls (vertex buffers, uniforms, pipeline IDs).
#[derive(Debug, Clone)]
pub enum DrawCommand {
    /// Clear the entire surface to the given RGBA color.
    Clear { rgba: [f32; 4] },
}

/// Allocate a mappable buffer big enough for a full RGBA8 readback at
/// the given size. wgpu requires `bytes_per_row` to be a multiple of
/// `wgpu::COPY_BYTES_PER_ROW_ALIGNMENT` (256); rows narrower than that
/// are padded.
fn make_readback(gpu: &Gpu, w: u32, h: u32) -> (wgpu::Buffer, u32) {
    let unpadded = w * 4;
    let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let padded = (unpadded + align - 1) / align * align;
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("carbon-canvas-readback"),
        size: (padded as u64) * (h as u64),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    (buffer, padded)
}

fn clamp_size(w: u32, h: u32) -> (u32, u32) {
    (w.max(1).min(8192), h.max(1).min(8192))
}

// ─── JS-facing registry helpers ────────────────────────────────────────
//
// These are wrapped by the Function::new closures in main.rs. We keep the
// surface objects in the global REGISTRY so the rasterizer (which is
// not on the JS thread) can borrow `last_pixels` for blitting.

/// Allocate a new surface; lazy-init the GPU on first call. Returns the
/// integer id JS will refer to it by.
pub fn create_surface(width: u32, height: u32) -> Result<u32> {
    let gpu = Gpu::get()?;
    let surface = CanvasSurface::new(gpu, width, height);
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.next_id = reg.next_id.checked_add(1).unwrap_or(1);
    let id = reg.next_id.max(1);
    reg.surfaces.insert(id, surface);
    Ok(id)
}

pub fn resize_surface(id: u32, width: u32, height: u32) -> Result<()> {
    let gpu = Gpu::get()?;
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = reg.surfaces.get_mut(&id) {
        s.resize(gpu, width, height);
    }
    Ok(())
}

pub fn clear_surface(id: u32, r: f32, g: f32, b: f32, a: f32) -> Result<()> {
    let gpu = Gpu::get()?;
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = reg.surfaces.get_mut(&id) {
        s.clear(gpu, r, g, b, a);
    }
    Ok(())
}

pub fn destroy_surface(id: u32) {
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.surfaces.remove(&id);
    reg.executors.remove(&id);
}

/// Phase 1.5δ entry: parse a JSON command list and run it against the surface.
/// Lazily creates a CanvasExecutor for this canvas on first call.
/// Errors are logged but never propagated — a malformed command must not
/// crash the JS-side runtime.
pub fn execute_commands_json(id: u32, json: &str) {
    if std::env::var_os("CARBON_MINI_TIMING").is_some() {
        eprintln!(
            "[carbon-mini-timing] phase=gpu_execute_commands id={id} json_len={}",
            json.len()
        );
    }
    let gpu = match Gpu::get() {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[carbon-mini] gpu unavailable, skipping execute_commands: {e:#}");
            return;
        }
    };
    // Parse outside the lock so we don't block other surfaces while parsing.
    let cmds = match crate::executor::parse_commands(json) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[carbon-mini] failed to parse draw commands: {e}");
            return;
        }
    };
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    if !reg.surfaces.contains_key(&id) {
        return;
    }
    if !reg.executors.contains_key(&id) {
        reg.executors.insert(id, CanvasExecutor::new(gpu));
    }
    // Split mutable borrows across the two HashMaps via field-disjoint
    // borrow: rust allows simultaneous &mut on `reg.surfaces` and
    // `reg.executors` only when we destructure (or borrow each field
    // through separate &mut references). Going through one `&mut reg`
    // twice triggers E0499. We rebind via field access.
    let CanvasRegistry {
        surfaces,
        executors,
        ..
    } = &mut *reg;
    let surface = surfaces.get_mut(&id).unwrap();
    let executor = executors.get_mut(&id).unwrap();
    executor.execute(gpu, surface, &cmds);
}

/// Read pixels for the rasterizer. Returns (width, height, rgba_bytes_clone).
/// We clone because tiny-skia paint runs while the registry mutex is
/// released; holding it during paint would serialize JS-side mutations.
pub fn read_surface_pixels(id: u32) -> Option<(u32, u32, Vec<u8>)> {
    // Lazy init only if a surface actually exists. We don't auto-create.
    if !surface_exists(id) {
        return None;
    }
    let gpu = Gpu::get().ok()?;
    let mut reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    let s = reg.surfaces.get_mut(&id)?;
    let bytes = s.read_pixels(gpu).to_vec();
    Some((s.width, s.height, bytes))
}

pub fn surface_exists(id: u32) -> bool {
    let reg = registry().lock().unwrap_or_else(|e| e.into_inner());
    reg.surfaces.contains_key(&id)
}

/// True if the GPU module has actually initialized its wgpu device.
/// Used by tests + bench harness to assert that UI-only apps never
/// trigger GPU init.
pub fn is_initialized() -> bool {
    GPU.get().is_some()
}

// ─── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Smoke test: idempotent get + clear + readback yields exactly the
    /// requested color. Skipped if no DX12 adapter is available (CI
    /// runners without a GPU).
    #[test]
    fn lazy_init_is_idempotent() {
        // Multiple gets must return the same instance.
        let a = match Gpu::get() {
            Ok(g) => g,
            Err(_) => return, // no GPU available in CI — skip
        };
        let b = Gpu::get().expect("second get");
        // Comparing pointers via ptr-eq on the Adapter: same handle.
        assert!(std::ptr::eq(a, b));
        assert!(is_initialized());
    }

    #[test]
    fn clear_then_readback_returns_color() {
        let gpu = match Gpu::get() {
            Ok(g) => g,
            Err(_) => return,
        };
        let mut s = CanvasSurface::new(gpu, 16, 8);
        s.clear(gpu, 1.0, 0.0, 0.0, 1.0);
        let pixels = s.read_pixels(gpu);
        // First pixel must be opaque red.
        assert_eq!(pixels[0..4], [255, 0, 0, 255]);
        // And the last one too.
        let last = pixels.len() - 4;
        assert_eq!(pixels[last..last + 4], [255, 0, 0, 255]);
    }

    #[test]
    fn execute_commands_clear() {
        let gpu = match Gpu::get() {
            Ok(g) => g,
            Err(_) => return,
        };
        let mut s = CanvasSurface::new(gpu, 4, 4);
        s.execute_commands(
            gpu,
            &[DrawCommand::Clear {
                rgba: [0.0, 1.0, 0.0, 1.0],
            }],
        );
        let p = s.read_pixels(gpu);
        assert_eq!(p[0..4], [0, 255, 0, 255]);
    }

    #[test]
    fn registry_create_and_destroy() {
        // If GPU init fails (no adapter), surface creation also fails;
        // the test then just exits without asserting registry size.
        let id = match create_surface(8, 8) {
            Ok(id) => id,
            Err(_) => return,
        };
        assert!(surface_exists(id));
        destroy_surface(id);
        assert!(!surface_exists(id));
    }
}
