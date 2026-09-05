// @carbon/plugins/screencapture — a still screenshot of a window or the
// full display, saved as a PNG (Windows only for now — see the
// screencapture plugin's own main.zig header comment).
//
// import { useScreenCapture } from "@carbon/plugins/screencapture";
// const { captureScreen, captureWindow } = useScreenCapture();
// captureScreen("captures/screen.png");
// captureWindow("captures/window.png"); // this app's own window
//
// Still images only — no recording. `captureWindow` captures this app's
// OWN window, not another app's. `path` is resolved relative to the app's
// project directory unless absolute.

import { useCallback } from "react";
import { captureScreen as rawCaptureScreen, captureWindow as rawCaptureWindow } from "carbon:screencapture";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseScreenCaptureResult {
  captureScreen: (path: string) => boolean;
  captureWindow: (path: string) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("captureScreen");
}

export function useScreenCapture(): UseScreenCaptureResult {
  const captureScreen = useCallback((path: string): boolean => (pluginReady() ? rawCaptureScreen(path) : false), []);
  const captureWindow = useCallback((path: string): boolean => (pluginReady() ? rawCaptureWindow(path) : false), []);
  return { captureScreen, captureWindow, ready: pluginReady() };
}
