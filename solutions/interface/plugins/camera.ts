// @carbon/plugins/camera — live video frame capture (Windows only for now
// — see the camera plugin's own main.zig header comment). Does NOT cover
// device enumeration/selection, resolution/format negotiation, still-
// photo capture, publishing this stream as a virtual camera source, or
// any macOS/Linux equivalent.
//
// import { useCamera } from "@carbon/plugins/camera";
// const { start, stop } = useCamera();
// start();
// carbon.on("camera.started", ({ width, height }) => { ... });
// carbon.on("camera.frame", (bytes: Uint8Array) => {
//   const imageData = new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.length), width, height);
//   ctx.putImageData(imageData, 0, 0); // RGBA8 — no channel swizzle needed
// });
// stop();
//
// `start()`/`stop()` only dispatch — the actual outcome and every frame
// after that arrive via `carbon.on(...)`, not this call's return value.
// See the plugin's own header comment for the full event catalog.

import { useCallback } from "react";
import { start as rawStart, stop as rawStop } from "carbon:camera";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseCameraResult {
  start: () => boolean;
  stop: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("start");
}

export function useCamera(): UseCameraResult {
  const start = useCallback((): boolean => (pluginReady() ? rawStart() : false), []);
  const stop = useCallback((): boolean => (pluginReady() ? rawStop() : false), []);

  return { start, stop, ready: pluginReady() };
}
