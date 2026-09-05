// @carbon/plugins/logging — structured native logs written to a file
// (JSONL), with size-based rotation (one `.1` backup).
//
// import { useLogging } from "@carbon/plugins/logging";
// const { log } = useLogging();
// log("logs/app.log", "info", "started");
//
// `path` is resolved relative to the app's project directory unless
// absolute. No requestAnimationFrame-deferral needed — see clipboard.ts's
// module doc comment for why (only ever called from an event handler,
// well after plugin registration has already happened).

import { useCallback } from "react";
import { log as rawLog } from "carbon:logging";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseLoggingResult {
  log: (path: string, level: string, message: string) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("log");
}

export function useLogging(): UseLoggingResult {
  const log = useCallback(
    (path: string, level: string, message: string): boolean =>
      pluginReady() ? rawLog(path, level, message) : false,
    [],
  );
  return { log, ready: pluginReady() };
}
