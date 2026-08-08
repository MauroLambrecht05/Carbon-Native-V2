// jsx-image.d.ts — JSX type declarations for the <image> intrinsic.
//
// Reference in your project's tsconfig.json:
//   { "compilerOptions": { "types": ["@carbon/mini-solid/types", "@carbon/mini-solid/types/jsx-image"] } }
//
// Or add a triple-slash reference in your entry file:
//   /// <reference types="@carbon/mini-solid/types/jsx-image" />

import "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      /**
       * Native image element backed by carbon-image.
       *
       * Phase 1: Displays image dimensions as a text fallback while the
       * GPU texture upload path (Phase 2) is not yet implemented.
       *
       * Phase 2: Will render the image as a wgpu RGBA8 texture blitted
       * into the scene via DrawCommand::Blit, using texture ids assigned
       * by __carbon_canvas_create_texture.
       */
      image: ImageIntrinsicProps;
    }
  }
}

/** Props for the `<image>` intrinsic element. */
export interface ImageIntrinsicProps {
  /** Path to the image file. Checked against the image.read capability glob. */
  src: string;
  /** Display width in pixels. Uses natural width if omitted. */
  width?: number;
  /** Display height in pixels. Uses natural height if omitted. */
  height?: number;
  /**
   * Fit mode for scaling the image within the display box.
   * Phase 2 only — currently treated as a hint and not applied.
   *   `contain` — scale to fit, preserving aspect ratio (default)
   *   `cover`   — scale to fill, may crop
   *   `fill`    — stretch to fill, may distort
   *   `none`    — no scaling, clip to box
   */
  fit?: "contain" | "cover" | "fill" | "none";
  /** Called once when the image has decoded successfully. */
  onLoad?: (img: import("./image-intrinsic").CarbonImageObj) => void;
  /** Called if the image fails to load or decode. */
  onError?: (err: Error) => void;
  /** Optional style overrides (applied to the container view). */
  style?: import("./jsx").CarbonStyle;
  children?: never;
}

/** Runtime shape of a decoded image returned by __carbon_image_load_path. */
export interface CarbonImageObj {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  textureId: number;
  toBytes(): Uint8Array;
}

// Global host bindings declared by register_image() in main.rs.
declare global {
  /**
   * Load a file from disk and decode it to RGBA8. Checks the
   * image.read capability glob before touching the filesystem.
   * Returns a pre-resolved Promise (synchronous decode on the JS thread).
   * Rejects with TypeError if the path is outside the allowed globs.
   */
  const __carbon_image_load_path: (path: string) => Promise<CarbonImageObj>;

  /**
   * Decode an ArrayBuffer (in-memory file data) to RGBA8.
   * No capability check — bytes are already in memory.
   * Returns a pre-resolved Promise.
   */
  const __carbon_image_load_bytes: (buffer: ArrayBuffer) => Promise<CarbonImageObj>;

  /**
   * Decode an ArrayBuffer synchronously. Suitable for small images loaded
   * at startup. Throws on decode failure. Does NOT return a Promise.
   */
  const __carbon_image_decode_sync: (buffer: ArrayBuffer) => CarbonImageObj;

  /**
   * Phase 2 stub: upload RGBA8 data to a wgpu texture on the given canvas.
   * Currently returns -1 (not implemented). Phase 2 will return a texture id
   * that can be used in DrawCommand::Blit.
   *
   * Interface (stable across Phase 1→2):
   *   canvasId — from __carbon_canvas_create()
   *   bytes    — RGBA8 pixel data, exactly width*height*4 bytes
   *   width, height — texture dimensions
   * Returns: texture id (>=0) on success, -1 on failure or not-yet-implemented.
   */
  const __carbon_canvas_create_texture: (
    canvasId: number,
    bytes: Uint8Array,
    width: number,
    height: number,
  ) => number;
}
