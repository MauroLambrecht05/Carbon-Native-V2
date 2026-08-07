/**
 * carbon-image — TypeScript types for the native image loader.
 *
 * These globals are registered by `register_image()` when
 * `[runtime] image = true` in carbon.toml. They are NOT available
 * in apps that don't opt-in.
 */

/**
 * A decoded image backed by native Rust memory.
 * Not directly constructible — instances come from the loader functions.
 */
declare class CarbonImage {
  /** Image width in pixels. */
  readonly width: number;
  /** Image height in pixels. */
  readonly height: number;
  /**
   * Pixel format (always 'rgba8' — all decoded images are normalised to
   * 8-bit RGBA regardless of source format).
   */
  readonly format: 'rgba8';
  /**
   * GPU texture id assigned after uploading via `__carbon_canvas_create_texture`.
   * -1 if not yet uploaded. Writable by the GPU integration layer.
   */
  textureId: number;
  /**
   * Returns a Uint8Array view of the raw RGBA8 pixel bytes.
   * The array is width × height × 4 bytes, row-major, top-left origin.
   *
   * This performs a single memcpy of the pixel data into a JS-owned buffer.
   */
  toBytes(): Uint8Array;
}

/**
 * Asynchronously load an image from a filesystem path.
 * The path is capability-checked against `[app.capabilities] "image.read"` globs.
 * Resolves with a `CarbonImage` on success; rejects with a `TypeError` if
 * the path is outside the allowed globs, and rejects with an `Error` on
 * decode failure.
 */
declare function __carbon_image_load_path(path: string): Promise<CarbonImage>;

/**
 * Asynchronously decode an image from an `ArrayBuffer` already in memory.
 * Not capability-checked (the bytes are already in JS memory).
 */
declare function __carbon_image_load_bytes(buf: ArrayBuffer): Promise<CarbonImage>;

/**
 * Synchronously decode an image from an `ArrayBuffer`.
 * Blocks the JS thread for the duration of decoding — use only for
 * small images or at startup. Not capability-checked.
 */
declare function __carbon_image_decode_sync(buf: ArrayBuffer): CarbonImage;

/**
 * Upload RGBA8 pixel data to a GPU texture on the given canvas surface.
 * Returns the integer texture id for use in DrawCommands, or -1 on failure.
 *
 * NOTE: this is currently a Phase 2 stub that logs and returns -1.
 * Full implementation tracked in docs/IMAGE_IMPL.md.
 */
declare function __carbon_canvas_create_texture(
  canvasId: number,
  bytes: Uint8Array,
  width: number,
  height: number
): number;
