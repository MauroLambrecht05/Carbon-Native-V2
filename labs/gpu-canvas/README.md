# carbon-gpu-canvas

A wgpu-backed `<canvas>` drawing surface, driven by JSON draw commands from
JS. Migrated and working (see `products/carbon/MIGRATION.md`) but parked
here rather than wired into a product — wgpu/canvas work resumes later, not
now.

Standalone, not part of the shared Cargo workspace or `bazel test //...`:

```bash
cd labs/gpu-canvas
cargo build
```

## Coming back

This was `solutions/capabilities/rendering/gpu` before it moved here. To
restore it:

1. Add it back to the `members` list in
   `.tools/orchestration/bazel/cargo/Cargo.toml`, and re-link its manifest
   to that workspace (`workspace.true` fields, the shared `[lints]` table)
   the way every other capability crate does.
2. Restore the `carbon-gpu-canvas` optional dependency and the `gpu`
   feature's activation list in `products/carbon/Cargo.toml` and
   `solutions/capabilities/rendering/painting/Cargo.toml` — both still have
   the `#[cfg(feature = "gpu")]` integration code, just permanently inert
   behind an empty feature.
3. Give it a real `BUILD.bazel` (`cargo_library` + `cargo_test`) — see any
   sibling capability under `solutions/capabilities/rendering/` for the
   pattern.
