// geometry.rs — Phase 1.5β: GPU geometry buffer cache for carbon-mini.
//
// Owned by 1.5β; consumed by the integrator (1.5δ). DO NOT modify
// gpu.rs / main.rs / scene.rs from here — the integrator wires this in.
//
// Responsibility:
//   * Cache uploaded vertex + index buffers keyed by `geometryId` (a u64
//     coerced from the JS-side three.js BufferGeometry id).
//   * Match the locked Phase 1.5 vertex layout exactly:
//       position: vec3<f32>  (12 B, offset  0)
//       normal:   vec3<f32>  (12 B, offset 12)
//       uv:       vec2<f32>  ( 8 B, offset 24)
//       color:    vec4<f32>  (16 B, offset 32)
//                            ────────────────
//                            48 B per vertex, alignment 16
//   * Hand the integrator a `&GeometryGpu { vbuf, ibuf, vertex_count,
//     index_count, index_format }` it can bind during a render pass.
//
// Eviction policy: explicit only. The JS bridge calls `evict(id)` when
// three.js disposes a BufferGeometry; we don't run a background LRU
// because Phase 1.5 doesn't have a memory budget yet (Phase 2 may add
// one once we have real workloads to measure). `memory_bytes()` is
// exposed so a future budgeter can decide when to call evict.

#![allow(dead_code)]

use std::collections::HashMap;

use wgpu::util::{BufferInitDescriptor, DeviceExt};

/// Locked vertex stride from `docs/PHASE1_5_CONTRACTS.md`.
/// position(12) + normal(12) + uv(8) + color(16) = 48.
pub const VERTEX_STRIDE: u64 = 48;

/// One uploaded geometry: a VBO, an IBO, and metadata for issuing the
/// draw call. Buffer handles are cheap-to-clone refcounts internally to
/// wgpu, but we hand them out by reference to keep ownership clear.
pub struct GeometryGpu {
    pub vbuf: wgpu::Buffer,
    pub ibuf: wgpu::Buffer,
    pub vertex_count: u32,
    pub index_count: u32,
    /// `Uint16` when the caller signaled the index data is u16, else
    /// `Uint32`. Picked by the integrator based on `vertex_count`
    /// (three.js uses u16 indices when vertices < 65536).
    pub index_format: wgpu::IndexFormat,
    /// Cached so `memory_bytes()` can sum without re-querying buffer
    /// sizes (wgpu doesn't expose a cheap size getter on Buffer in 27).
    vbuf_bytes: usize,
    ibuf_bytes: usize,
}

impl GeometryGpu {
    /// Total VRAM (vbuf + ibuf) for this entry.
    pub fn memory_bytes(&self) -> usize {
        self.vbuf_bytes + self.ibuf_bytes
    }
}

/// Process-local cache of uploaded geometry. The integrator owns one
/// of these per executor (currently one global executor).
pub struct GeometryCache {
    entries: HashMap<u64, GeometryGpu>,
}

impl GeometryCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Look up by geometryId. `None` means "integrator must call
    /// `upload`" — Phase 2 always sends the bytes alongside the first
    /// reference to a new geometry, so this is the cache-miss signal.
    pub fn get(&self, id: u64) -> Option<&GeometryGpu> {
        self.entries.get(&id)
    }

    /// Upload (or replace) geometry at `id`. The buffers are created with
    /// `VERTEX | COPY_DST` and `INDEX | COPY_DST` so the integrator can
    /// later `queue.write_buffer` over them if a future "geometry update
    /// in place" path lands. For now, replace = drop the old buffers and
    /// allocate fresh ones (wgpu's drop is async-safe; the buffers stay
    /// alive until any in-flight commands referencing them complete).
    ///
    /// `vertices` is the raw bytes of the interleaved Float32Array; its
    /// length must equal `vertex_count * 48`. We assert this in debug
    /// builds; in release we just upload whatever the caller hands us
    /// (the integrator validates upstream).
    ///
    /// `indices` is the raw bytes of either a Uint16Array or Uint32Array;
    /// `index_is_u32` selects which. The caller decides based on
    /// `vertex_count` (three.js uses u16 when verts < 65536).
    pub fn upload(
        &mut self,
        device: &wgpu::Device,
        _queue: &wgpu::Queue,
        id: u64,
        vertices: &[u8],
        indices: &[u8],
        index_is_u32: bool,
        vertex_count: u32,
        index_count: u32,
    ) {
        debug_assert_eq!(
            vertices.len() as u64,
            vertex_count as u64 * VERTEX_STRIDE,
            "vertex byte length must equal vertex_count * 48 (locked stride)"
        );
        debug_assert_eq!(
            indices.len() as u64,
            index_count as u64 * if index_is_u32 { 4 } else { 2 },
            "index byte length must match index_count * sizeof(index)"
        );

        // create_buffer_init copies the slice into a mapped buffer at
        // creation time, then unmaps — one allocation, no separate
        // queue.write_buffer needed. wgpu pads to COPY_BUFFER_ALIGNMENT
        // (4) internally, so we don't need to round up here.
        let vbuf = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("carbon-geometry-vbuf"),
            contents: vertices,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        });
        let ibuf = device.create_buffer_init(&BufferInitDescriptor {
            label: Some("carbon-geometry-ibuf"),
            contents: indices,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
        });

        let entry = GeometryGpu {
            vbuf,
            ibuf,
            vertex_count,
            index_count,
            index_format: if index_is_u32 {
                wgpu::IndexFormat::Uint32
            } else {
                wgpu::IndexFormat::Uint16
            },
            vbuf_bytes: vertices.len(),
            ibuf_bytes: indices.len(),
        };

        // Replace semantics: HashMap::insert returns the prior value
        // (if any) which Drop will free. The actual GPU-side free is
        // deferred by wgpu until any pending submissions release it.
        self.entries.insert(id, entry);
    }

    /// Drop a single entry. Called from the JS bridge when three.js
    /// fires `BufferGeometry.dispose()`. No-op if `id` isn't cached.
    pub fn evict(&mut self, id: u64) {
        self.entries.remove(&id);
    }

    /// Total bytes (vbuf + ibuf, summed over all entries) currently
    /// resident in the cache. Cheap — we cache each entry's size at
    /// upload time. Useful for a future memory budget watchdog.
    pub fn memory_bytes(&self) -> usize {
        self.entries.values().map(|e| e.memory_bytes()).sum()
    }

    /// Number of cached geometries. Handy for tests + telemetry.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl Default for GeometryCache {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Tests ─────────────────────────────────────────────────────────────
//
// Tests gate themselves at runtime: if no DX12 adapter is available
// (CI runners without a GPU) we return early instead of panicking. This
// matches the pattern in `gpu.rs::tests`. We don't use a feature flag
// because the dev-host machine has a GPU and we want the tests to run
// by default there without a special cargo invocation.

#[cfg(test)]
mod tests {
    use super::*;
    use pollster::block_on;

    /// Try to acquire a wgpu Device + Queue. Returns `None` if the
    /// environment has no compatible adapter — caller should bail in
    /// that case rather than panicking, so the tests are CI-friendly.
    fn try_device() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            // PRIMARY = native backends (Vulkan/Metal/DX12); SECONDARY =
            // GL fallbacks. Whichever the host has, we'll take.
            backends: wgpu::Backends::PRIMARY | wgpu::Backends::SECONDARY,
            backend_options: wgpu::BackendOptions::default(),
            flags: wgpu::InstanceFlags::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
        });
        let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: None,
            force_fallback_adapter: false,
        }))
        .ok()?;
        let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("carbon-geometry-test"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            memory_hints: wgpu::MemoryHints::default(),
            trace: wgpu::Trace::Off,
            experimental_features: wgpu::ExperimentalFeatures::default(),
        }))
        .ok()?;
        Some((device, queue))
    }

    /// Build a 3-vertex triangle in the locked interleaved layout. Each
    /// vertex is exactly 12 floats = 48 B; total 144 B for the VBO.
    fn make_triangle_vertices() -> Vec<u8> {
        let verts: [[f32; 12]; 3] = [
            // pos (3)        normal (3)      uv (2)     color (4)
            [0.0, 0.5, 0.0, 0.0, 0.0, 1.0, 0.5, 1.0, 1.0, 0.0, 0.0, 1.0],
            [-0.5, -0.5, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0],
            [0.5, -0.5, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0],
        ];
        let mut bytes = Vec::with_capacity(3 * 48);
        for v in &verts {
            for f in v {
                bytes.extend_from_slice(&f.to_le_bytes());
            }
        }
        debug_assert_eq!(bytes.len(), 3 * 48);
        bytes
    }

    fn make_triangle_indices_u16() -> Vec<u8> {
        let idx: [u16; 3] = [0, 1, 2];
        let mut bytes = Vec::with_capacity(6);
        for i in &idx {
            bytes.extend_from_slice(&i.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn upload_triangle_then_get() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return, // no GPU in CI — skip
        };
        let mut cache = GeometryCache::new();
        let verts = make_triangle_vertices();
        let idx = make_triangle_indices_u16();
        cache.upload(&device, &queue, 42, &verts, &idx, false, 3, 3);

        let g = cache.get(42).expect("just-uploaded entry must be present");
        assert_eq!(g.vertex_count, 3);
        assert_eq!(g.index_count, 3);
        assert_eq!(g.index_format, wgpu::IndexFormat::Uint16);
        assert_eq!(g.vbuf_bytes, 144);
        assert_eq!(g.ibuf_bytes, 6);
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn upload_replaces_existing() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let mut cache = GeometryCache::new();
        let verts = make_triangle_vertices();
        let idx = make_triangle_indices_u16();
        cache.upload(&device, &queue, 7, &verts, &idx, false, 3, 3);
        let bytes_after_first = cache.memory_bytes();
        assert_eq!(bytes_after_first, 144 + 6);

        // Upload again with same id — must replace, not double-count.
        cache.upload(&device, &queue, 7, &verts, &idx, false, 3, 3);
        assert_eq!(cache.len(), 1, "replace must not grow the map");
        assert_eq!(
            cache.memory_bytes(),
            bytes_after_first,
            "replace must not double-count memory"
        );
    }

    #[test]
    fn evict_removes_entry() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let mut cache = GeometryCache::new();
        let verts = make_triangle_vertices();
        let idx = make_triangle_indices_u16();
        cache.upload(&device, &queue, 99, &verts, &idx, false, 3, 3);
        assert!(cache.get(99).is_some());
        cache.evict(99);
        assert!(cache.get(99).is_none());
        assert_eq!(cache.memory_bytes(), 0);

        // Evicting a missing id must be a no-op, not a panic.
        cache.evict(99);
        cache.evict(12345);
    }

    #[test]
    fn memory_bytes_sums_entries() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let mut cache = GeometryCache::new();
        let verts = make_triangle_vertices();
        let idx = make_triangle_indices_u16();
        cache.upload(&device, &queue, 1, &verts, &idx, false, 3, 3);
        cache.upload(&device, &queue, 2, &verts, &idx, false, 3, 3);
        cache.upload(&device, &queue, 3, &verts, &idx, false, 3, 3);
        // Each entry: 144 B vbuf + 6 B ibuf = 150 B. Three of them: 450.
        assert_eq!(cache.memory_bytes(), 3 * (144 + 6));
        assert_eq!(cache.len(), 3);
    }

    #[test]
    fn u32_indices_path() {
        let (device, queue) = match try_device() {
            Some(d) => d,
            None => return,
        };
        let mut cache = GeometryCache::new();
        let verts = make_triangle_vertices();
        // Three u32 indices = 12 B.
        let idx32: [u32; 3] = [0, 1, 2];
        let mut idx_bytes = Vec::with_capacity(12);
        for i in &idx32 {
            idx_bytes.extend_from_slice(&i.to_le_bytes());
        }
        cache.upload(&device, &queue, 5, &verts, &idx_bytes, true, 3, 3);
        let g = cache.get(5).unwrap();
        assert_eq!(g.index_format, wgpu::IndexFormat::Uint32);
        assert_eq!(g.ibuf_bytes, 12);
    }
}
