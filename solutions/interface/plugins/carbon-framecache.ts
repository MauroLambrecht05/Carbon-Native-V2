// @carbon/plugins/carbon-framecache — startup frame-cache diagnostics and
// control. Not an OS or hosted-cloud capability — see the
// carbon-framecache plugin's own main.zig header comment. `hit` is always
// `false` on the blitz backend, which has no such cache — not a failure.
//
// import { useCarbonFramecache } from "@carbon/plugins/carbon-framecache";
// const { getStats, clear } = useCarbonFramecache();
// const { hit } = getStats()!;
// clear(); // force the next launch to rebuild the cache

import { useCallback } from "react";
import { getStats as rawGetStats, clear as rawClear } from "carbon:carbon-framecache";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface FramecacheStats {
  hit: boolean;
}

export interface UseCarbonFramecacheResult {
  getStats: () => FramecacheStats | null;
  clear: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("getStats");
}

export function useCarbonFramecache(): UseCarbonFramecacheResult {
  const getStats = useCallback((): FramecacheStats | null => (pluginReady() ? rawGetStats() : null), []);
  const clear = useCallback((): boolean => (pluginReady() ? rawClear() : false), []);

  return { getStats, clear, ready: pluginReady() };
}
