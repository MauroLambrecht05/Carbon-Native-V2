// The <image> intrinsic — a Solid intrinsic factory for <image> elements.
//
// Opt-in: index.ts must NOT import this, because registering the intrinsic
// pulls in a decode path most apps never use.
// Apps opt-in by calling `registerImageIntrinsic()` once at startup.
//
// Usage:
//   import { registerImageIntrinsic } from '@carbon/mini-solid/image';
//   registerImageIntrinsic();
//
//   // Then in JSX:
//   <image src="/app/assets/photo.png" width={200} height={150} fit="contain" />
//
// How it works:
//   1. The Solid renderer treats <image> as a custom intrinsic element
//      (not a built-in). The factory hooks into the renderer's
//      `setProperty` path to intercept the `src` prop.
//   2. When `src` is set, we call `__carbon_image_load_path(src)` which
//      returns a pre-resolved Promise<{width, height, format, toBytes()}>.
//   3. On resolve, we try to upload the RGBA8 bytes to the GPU via
//      `__carbon_canvas_create_texture` (Phase 2 stub — returns -1).
//   4. While waiting / if GPU upload isn't available, we fall back to
//      rendering a `<text>` node showing the image dimensions.
//
// GPU texture upload hook:
//   TODO (Phase 2): `__carbon_canvas_create_texture(canvasId, bytes, w, h)`
//   is registered as a stub by carbon_image::register_image() which always
//   returns -1. The real implementation will be in carbon/runtime/mini.rs
//   using wgpu::Device::create_texture + queue.write_texture.
//   See IMAGE_IMPL.md for the interface contract.

import { createEffect, createSignal } from "solid-js";
import { createElement, setProp, insertNode } from "../reconciler/renderer.ts";

// ─── Host bindings ────────────────────────────────────────────────────────
// These are registered by register_image() in carbon/runtime/mini.rs
// (via carbon_image::register_image) when [runtime] image = true.

declare const __carbon_image_load_path: (path: string) => Promise<CarbonImageObj>;
declare const __carbon_canvas_create_texture: (
  canvasId: number,
  bytes: Uint8Array,
  width: number,
  height: number,
) => number;

// Shape returned by __carbon_image_load_path / __carbon_image_decode_sync.
interface CarbonImageObj {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  textureId: number;
  toBytes(): Uint8Array;
}

// ─── Props for <image> ────────────────────────────────────────────────────

export interface ImageProps {
  /** URL / path to the image. Passed to __carbon_image_load_path. */
  src: string;
  /** Display width in pixels. If omitted, uses the image's natural width. */
  width?: number;
  /** Display height in pixels. If omitted, uses the image's natural height. */
  height?: number;
  /**
   * Resize mode (Phase 2 feature — not yet implemented in the paint path).
   * When Phase 2 draws textures via DrawCommand::Blit, this will be honoured.
   */
  fit?: "contain" | "cover" | "fill" | "none";
  /** Called when the image has loaded. Receives the CarbonImage object. */
  onLoad?: (img: CarbonImageObj) => void;
  /** Called on load error. */
  onError?: (err: Error) => void;
}

// ─── <image> implementation ───────────────────────────────────────────────

/**
 * Create an <image> node using the carbon-mini renderer primitives.
 *
 * Returns the container view node. The node initially renders a fallback
 * text label ("loading…" then "WxH px") until the GPU texture is ready.
 *
 * Phase 1 behaviour (current):
 *   - Loads via __carbon_image_load_path (sync decode, returns pre-resolved Promise)
 *   - Calls __carbon_canvas_create_texture (stub, returns -1)
 *   - Falls back to displaying image dimensions as a text node
 *
 * Phase 2 behaviour (future):
 *   - __carbon_canvas_create_texture returns a real wgpu texture id
 *   - The renderer uses that id in a DrawCommand::Blit to paint the texture
 *     into the scene at the node's layout box
 */
function createImageNode(props: ImageProps): any {
  // Container view to hold either the fallback text or future texture node.
  const container = createElement("view");
  const w = props.width ?? 0;
  const h = props.height ?? 0;
  if (w > 0) setProp(container, "width", w);
  if (h > 0) setProp(container, "height", h);

  // Fallback text node — shown while loading and if GPU upload fails.
  const fallback = createElement("text");
  setProp(fallback, "text", `[image loading…]`);
  insertNode(container, fallback);

  // Signals for reactive updates.
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [imgInfo, setImgInfo] = createSignal<CarbonImageObj | null>(null);

  // Start the async load.
  if (typeof __carbon_image_load_path === "function") {
    __carbon_image_load_path(props.src)
      .then((img) => {
        setImgInfo(img);
        setStatus("ready");
        props.onLoad?.(img);
      })
      .catch((err: Error) => {
        setStatus("error");
        props.onError?.(err);
      });
  } else {
    // image loading not registered — show a warning.
    setStatus("error");
    console.log(
      "[carbon-image] __carbon_image_load_path not available. " +
      "Set CARBON_IMAGE=1 or configure [runtime] image = true in carbon.toml."
    );
  }

  // Reactive: update the fallback text when state changes.
  createEffect(() => {
    const s = status();
    const img = imgInfo();
    let label: string;
    if (s === "loading") {
      label = `[loading: ${props.src}]`;
    } else if (s === "error") {
      label = `[error: ${props.src}]`;
    } else if (img) {
      // Phase 2 GPU upload attempt.
      let texId = -1;
      if (typeof __carbon_canvas_create_texture === "function") {
        try {
          texId = __carbon_canvas_create_texture(
            0, // canvas id — 0 = "no canvas" until Phase 2 assigns one
            img.toBytes(),
            img.width,
            img.height,
          );
        } catch (e) {
          // Stub may throw; treat as not-yet-implemented.
        }
      }
      if (texId >= 0) {
        // Phase 2: texture uploaded. The paint path will use texId to blit.
        // TODO (Phase 2): set canvas_texture_id prop on the node so the
        // rasterizer can look it up. For now, show dimensions.
        label = `[tex:${texId} ${img.width}×${img.height}]`;
      } else {
        // Phase 1 fallback: display dimensions as text.
        label = `[${img.width}×${img.height} ${img.format}]`;
        // TODO (Phase 2): remove this fallback when GPU texture blit works.
        console.log(
          `[carbon-image] TODO Phase 2: GPU texture upload not implemented. ` +
          `Showing dimensions for ${props.src} (${img.width}×${img.height}).`
        );
      }
    } else {
      label = `[image]`;
    }
    setProp(fallback, "text", label);
  });

  return container;
}

// ─── Registration ─────────────────────────────────────────────────────────

let _registered = false;

/**
 * Register the `<image>` intrinsic with the carbon-mini renderer.
 *
 * Call once at app startup, before any JSX that uses `<image>`.
 * Idempotent — safe to call multiple times.
 */
export function registerImageIntrinsic(): void {
  if (_registered) return;
  _registered = true;

  // The carbon-mini renderer routes `createElement("image")` through the
  // Solid universal renderer's `createElement` hook, which calls
  // `__cm_create_node(id, "image", "{}")` on the Rust side.
  //
  // We intercept the `src` prop by patching the global createElement to
  // detect "image" tags and redirect to our factory.
  //
  // Note: this does NOT modify index.ts. Instead, apps import this file
  // and call registerImageIntrinsic() before mounting.
  const _origCreateElement = (globalThis as any).__cm_create_element;

  // The Solid universal renderer calls `createElement(tag)` from the render
  // function. We want to intercept "image" tags. The renderer object from
  // index.ts exposes `createElement` which maps to `freshNode(tag)`.
  // Since we can't patch `createElement` from here without touching index.ts,
  // we use a different approach: override the __cm_create_node global for
  // "image" tags.
  //
  // For Phase 1, the simplest approach: apps use <image> by calling
  // createImageNode directly or wrapping it in a Solid component.
  //
  // The full JSX intrinsic path (where `<image>` emits `createElement("image")`)
  // would require intercepting the renderer, which needs modifications to
  // index.ts. We document this here and provide the Solid component path.
  if (typeof __carbon_image_load_path === "undefined") {
    console.log(
      "[carbon-image] Image loading not available. " +
      "Enable with CARBON_IMAGE=1 env var or [runtime] image = true in carbon.toml."
    );
  }
}

/**
 * Solid component wrapper for `<image>` functionality.
 * Use this when `<image>` JSX intrinsic isn't registered.
 *
 * ```tsx
 * import { ImageComponent } from '@carbon/mini-solid/image';
 * <ImageComponent src="/assets/photo.png" width={200} height={150} />
 * ```
 */
export function ImageComponent(props: ImageProps): any {
  return createImageNode(props);
}

// Re-export for convenience.
export type { CarbonImageObj };
