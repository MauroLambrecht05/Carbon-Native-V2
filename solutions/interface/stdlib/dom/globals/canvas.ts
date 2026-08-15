// The canvas-adjacent constructors libraries reach for at module init.
//
// The per-element `<canvas>.getContext('2d')` wiring is in shims/node.ts;
// these are the free-standing globals — `new OffscreenCanvas()`, `new
// ImageData()`, the `instanceof` targets, `createImageBitmap`, `Path2D`,
// and `devicePixelRatio`.

import {
  CarbonCanvasContext2D,
  CarbonCanvasGradient,
  CarbonImageData,
  CarbonOffscreenCanvas,
} from "../shims/canvas.ts";

declare const __cm_window_device_pixel_ratio: (() => number) | undefined;

export function installCanvasGlobals(g: any): void {
  // Canvas 2D primitives. <canvas>.getContext('2d') is wired per-element in
  // node.ts (createElement). These globals satisfy `new OffscreenCanvas()`,
  // `new ImageData()`, `instanceof CanvasRenderingContext2D` / `CanvasGradient`
  // checks, and `new Path2D()` (a minimal stub) that canvas libraries do at
  // module-init. The real drawing is backed by canvas2d.rs.
  if (typeof (g as any).OffscreenCanvas === "undefined") {
    (g as any).OffscreenCanvas = CarbonOffscreenCanvas;
    if (g.window) g.window.OffscreenCanvas = CarbonOffscreenCanvas;
  }
  if (typeof (g as any).ImageData === "undefined") {
    (g as any).ImageData = CarbonImageData;
    if (g.window) g.window.ImageData = CarbonImageData;
  }
  if (typeof (g as any).CanvasRenderingContext2D === "undefined") {
    (g as any).CanvasRenderingContext2D = CarbonCanvasContext2D;
    if (g.window) g.window.CanvasRenderingContext2D = CarbonCanvasContext2D;
  }
  if (typeof (g as any).OffscreenCanvasRenderingContext2D === "undefined") {
    (g as any).OffscreenCanvasRenderingContext2D = CarbonCanvasContext2D;
  }
  if (typeof (g as any).CanvasGradient === "undefined") {
    (g as any).CanvasGradient = CarbonCanvasGradient;
    if (g.window) g.window.CanvasGradient = CarbonCanvasGradient;
  }
  // createImageBitmap — xterm's canvas renderer turns its glyph-atlas
  // <canvas> into an ImageBitmap for fast drawImage blits. We model an
  // ImageBitmap as a lightweight handle to the SAME backing surface (the
  // atlas is append-only, so sharing the live surface is correct and
  // avoids a full pixel copy). drawImage reads `__cmSurfaceId` off it.
  if (typeof (g as any).createImageBitmap === "undefined") {
    const createImageBitmap = (source: any): Promise<any> => {
      const surfaceId = source?.__cmSurfaceId ?? source?.cmId;
      const bitmap = {
        __cmSurfaceId: surfaceId,
        width: source?.width ?? 0,
        height: source?.height ?? 0,
        close() {},
      };
      return Promise.resolve(bitmap);
    };
    (g as any).createImageBitmap = createImageBitmap;
    if (g.window) g.window.createImageBitmap = createImageBitmap;
  }
  // devicePixelRatio on globalThis/self (window already exposes a getter).
  // Canvas libraries read it off whichever global they reach for.
  if (typeof (g as any).devicePixelRatio === "undefined") {
    try {
      Object.defineProperty(g, "devicePixelRatio", {
        configurable: true,
        get(): number {
          try { return g.window ? g.window.devicePixelRatio : 1; } catch { return 1; }
        },
      });
    } catch { (g as any).devicePixelRatio = 1; }
  }
  if (typeof (g as any).Path2D === "undefined") {
    class CarbonPath2D {
      addPath(): void {}
      closePath(): void {}
      moveTo(): void {}
      lineTo(): void {}
      bezierCurveTo(): void {}
      quadraticCurveTo(): void {}
      arc(): void {}
      arcTo(): void {}
      ellipse(): void {}
      rect(): void {}
      roundRect(): void {}
    }
    (g as any).Path2D = CarbonPath2D;
    if (g.window) g.window.Path2D = CarbonPath2D;
  }
}
