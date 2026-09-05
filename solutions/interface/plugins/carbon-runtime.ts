// @carbon/plugins/carbon-runtime — introspects which Carbon backend
// binary is running and which of its own Cargo feature flags were
// compiled in. Not an OS or hosted-cloud capability — see the
// carbon-runtime plugin's own main.zig header comment.
//
// import { useCarbonRuntime } from "@carbon/plugins/carbon-runtime";
// const { getRuntimeInfo } = useCarbonRuntime();
// const { backend, features, abiVersion } = getRuntimeInfo()!;

import { useCallback } from "react";
import { getRuntimeInfo as rawGetRuntimeInfo } from "carbon:carbon-runtime";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface RuntimeFeatures {
  network: boolean;
  svg: boolean;
  image: boolean;
  audio: boolean;
  updater: boolean;
  snapshot: boolean;
  gpu: boolean;
  profiling: boolean;
}

export interface RuntimeInfo {
  backend: "mini" | "blitz" | string;
  features: RuntimeFeatures;
  abiVersion: { major: number; minor: number };
}

export interface UseCarbonRuntimeResult {
  getRuntimeInfo: () => RuntimeInfo | null;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("getRuntimeInfo");
}

export function useCarbonRuntime(): UseCarbonRuntimeResult {
  const getRuntimeInfo = useCallback((): RuntimeInfo | null => (pluginReady() ? rawGetRuntimeInfo() : null), []);

  return { getRuntimeInfo, ready: pluginReady() };
}
