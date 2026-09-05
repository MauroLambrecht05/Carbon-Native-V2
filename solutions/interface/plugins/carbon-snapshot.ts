// @carbon/plugins/carbon-snapshot — reports whether this session's JS
// runtime was restored from a pre-built QuickJS heap snapshot rather than
// freshly evaluating the bundle. Not an OS/hosted-cloud capability, and
// NOT a pixel/screenshot capability despite the name — see the
// carbon-snapshot plugin's own main.zig header comment.
//
// import { useCarbonSnapshot } from "@carbon/plugins/carbon-snapshot";
// const { wasRestoredFromSnapshot } = useCarbonSnapshot();
// if (wasRestoredFromSnapshot()) { /* cold-start was skipped */ }

import { useCallback } from "react";
import { wasRestoredFromSnapshot as rawWasRestoredFromSnapshot } from "carbon:carbon-snapshot";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseCarbonSnapshotResult {
  wasRestoredFromSnapshot: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("wasRestoredFromSnapshot");
}

export function useCarbonSnapshot(): UseCarbonSnapshotResult {
  const wasRestoredFromSnapshot = useCallback(
    (): boolean => (pluginReady() ? rawWasRestoredFromSnapshot() : false),
    [],
  );

  return { wasRestoredFromSnapshot, ready: pluginReady() };
}
