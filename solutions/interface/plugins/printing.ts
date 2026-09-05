// @carbon/plugins/printing — sends an existing file to the system print
// job (Windows only for now — see the printing plugin's own main.zig
// header comment).
//
// import { usePrinting } from "@carbon/plugins/printing";
// const { printFile } = usePrinting();
// printFile("export/report.pdf");
//
// Prints an EXISTING FILE through whatever the OS has associated as that
// file type's print handler — not "render this HTML/JSX and print it".
// `path` is resolved relative to the app's project directory unless
// absolute.

import { useCallback } from "react";
import { printFile as rawPrintFile } from "carbon:printing";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UsePrintingResult {
  printFile: (path: string) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("printFile");
}

export function usePrinting(): UsePrintingResult {
  const printFile = useCallback((path: string): boolean => (pluginReady() ? rawPrintFile(path) : false), []);
  return { printFile, ready: pluginReady() };
}
