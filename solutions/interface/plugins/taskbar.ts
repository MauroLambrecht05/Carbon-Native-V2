// @carbon/plugins/taskbar — a badge and progress overlay on the app's
// taskbar button (Windows only for now — see the taskbar plugin's own
// main.zig header comment).
//
// import { useTaskbar } from "@carbon/plugins/taskbar";
// const { setProgress, clearProgress, setBadge, clearBadge } = useTaskbar();
// setProgress(3, 10);           // 30% progress overlay
// setBadge("assets/badge.png"); // a pre-rendered PNG overlay icon
//
// There is no native Windows numeric badge — `setBadge` sets an OVERLAY
// ICON (a small icon composited onto the taskbar button), the accepted
// equivalent; the app supplies its own pre-rendered image rather than
// this plugin rendering text into one itself.
//
// No requestAnimationFrame-deferral needed — see clipboard.ts's module doc
// comment for why (only ever called from an event handler, well after
// plugin registration has already happened).

import { useCallback } from "react";
import {
  setProgress as rawSetProgress,
  clearProgress as rawClearProgress,
  setBadge as rawSetBadge,
  clearBadge as rawClearBadge,
} from "carbon:taskbar";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseTaskbarResult {
  setProgress: (completed: number, total: number) => boolean;
  clearProgress: () => boolean;
  setBadge: (iconPath: string, description?: string) => boolean;
  clearBadge: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("setProgress");
}

export function useTaskbar(): UseTaskbarResult {
  const setProgress = useCallback(
    (completed: number, total: number): boolean => (pluginReady() ? rawSetProgress(completed, total) : false),
    [],
  );
  const clearProgress = useCallback((): boolean => (pluginReady() ? rawClearProgress() : false), []);
  const setBadge = useCallback(
    (iconPath: string, description?: string): boolean =>
      pluginReady() ? rawSetBadge(iconPath, description ?? "") : false,
    [],
  );
  const clearBadge = useCallback((): boolean => (pluginReady() ? rawClearBadge() : false), []);

  return { setProgress, clearProgress, setBadge, clearBadge, ready: pluginReady() };
}
