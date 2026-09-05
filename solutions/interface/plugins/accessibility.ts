// @carbon/plugins/accessibility — detects when a screen-reader-class
// assistive technology is active (Windows only for now — see the
// accessibility plugin's own main.zig header comment).
//
// import { useAccessibility } from "@carbon/plugins/accessibility";
// const { isScreenReaderActive } = useAccessibility();
// if (isScreenReaderActive()) { /* adapt */ }
//
// A point-in-time query, not a subscription — there is no live
// "assistive technology started/stopped" event to listen for on Windows.

import { useCallback } from "react";
import { isScreenReaderActive as rawQuery } from "carbon:accessibility";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseAccessibilityResult {
  isScreenReaderActive: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("isScreenReaderActive");
}

export function useAccessibility(): UseAccessibilityResult {
  const isScreenReaderActive = useCallback((): boolean => (pluginReady() ? rawQuery() : false), []);
  return { isScreenReaderActive, ready: pluginReady() };
}
