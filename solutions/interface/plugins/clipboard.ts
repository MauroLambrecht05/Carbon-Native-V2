// @carbon/plugins/clipboard — the system clipboard, text only.
//
// import { useClipboard } from "@carbon/plugins/clipboard";
// const { readText, writeText } = useClipboard();
// <view onClick={() => writeText("hello")}>...
//
// Unlike fonts, this doesn't need the requestAnimationFrame-deferral dance
// (see fonts.ts's module doc comment for why that one does): clipboard
// calls happen from event handlers — a click, a keydown — which only ever
// fire well after `carbon_plugin_register` has already installed this
// plugin's globals (registration happens once, at startup, long before any
// user interaction is possible). So the functions below call straight
// through; `ready` is exposed only for the rare case of wanting to know
// before the first interaction.

import { useCallback } from "react";
import { readText as rawReadText, writeText as rawWriteText, clear as rawClear } from "carbon:clipboard";

export interface UseClipboardResult {
  /** Empty string if the clipboard has no text or the plugin isn't ready yet. */
  readText: () => string;
  writeText: (text: string) => boolean;
  clear: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return typeof (globalThis as unknown as { readText?: unknown }).readText === "function";
}

export function useClipboard(): UseClipboardResult {
  const readText = useCallback((): string => (pluginReady() ? rawReadText() : ""), []);
  const writeText = useCallback((text: string): boolean => (pluginReady() ? rawWriteText(text) : false), []);
  const clear = useCallback((): boolean => (pluginReady() ? rawClear() : false), []);

  return { readText, writeText, clear, ready: pluginReady() };
}
