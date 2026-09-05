// @carbon/plugins/theme — accent color, high-contrast, and reduced-motion
// preference detection (Windows only for now — see the theme plugin's own
// main.zig header comment).
//
// import { useThemePrefs } from "@carbon/plugins/theme";
// const { queryThemePrefs } = useThemePrefs();
// const { accentColor, highContrast, reducedMotion } = queryThemePrefs();
//
// A point-in-time query, not a subscription — live light/dark theme and
// window-focus changes are already ambient
// (`onThemeChange`/`onWindowFocus` from `@carbon/mini-solid`); re-call
// this after one of those fires if you want these three to stay live too.
//
// No requestAnimationFrame-deferral needed — see clipboard.ts's module doc
// comment for why (only ever called from an event handler, well after
// plugin registration has already happened).

import { useCallback } from "react";
import { queryThemePrefs as rawQuery } from "carbon:theme";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface ThemePrefs {
  accentColor: string;
  highContrast: boolean;
  reducedMotion: boolean;
}

export interface UseThemePrefsResult {
  queryThemePrefs: () => ThemePrefs | null;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("queryThemePrefs");
}

export function useThemePrefs(): UseThemePrefsResult {
  const queryThemePrefs = useCallback((): ThemePrefs | null => (pluginReady() ? rawQuery() : null), []);
  return { queryThemePrefs, ready: pluginReady() };
}
