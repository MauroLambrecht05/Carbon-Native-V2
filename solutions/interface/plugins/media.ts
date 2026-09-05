// @carbon/plugins/media — system audio volume/mute and hardware media-key
// handling (Windows only for now — see the media plugin's own main.zig
// header comment). Does NOT cover now-playing metadata in the OS media
// overlay or a hardware-accelerated video decode surface — a separate,
// larger piece of work, not yet built.
//
// import { useMedia } from "@carbon/plugins/media";
// const { getVolume, setVolume, getMuted, setMuted, listenMediaKeys } = useMedia();
// setVolume(0.5);
// listenMediaKeys();
//
// Media-key presses arrive via `carbon.on("media.key", ({ key }) => ...)`
// (`key` is `"playpause"|"next"|"previous"|"stop"`) once `listenMediaKeys()`
// has been called — same `carbon.on`/`carbon.off` shim tray/global-
// shortcuts/deep-link already install.

import { useCallback } from "react";
import {
  getVolume as rawGetVolume,
  setVolume as rawSetVolume,
  getMuted as rawGetMuted,
  setMuted as rawSetMuted,
  listenMediaKeys as rawListenMediaKeys,
} from "carbon:media";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseMediaResult {
  getVolume: () => number | null;
  setVolume: (level: number) => boolean;
  getMuted: () => boolean | null;
  setMuted: (muted: boolean) => boolean;
  listenMediaKeys: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("getVolume");
}

export function useMedia(): UseMediaResult {
  const getVolume = useCallback((): number | null => (pluginReady() ? rawGetVolume() : null), []);
  const setVolume = useCallback((level: number): boolean => (pluginReady() ? rawSetVolume(level) : false), []);
  const getMuted = useCallback((): boolean | null => (pluginReady() ? rawGetMuted() : null), []);
  const setMuted = useCallback((muted: boolean): boolean => (pluginReady() ? rawSetMuted(muted) : false), []);
  const listenMediaKeys = useCallback((): boolean => (pluginReady() ? rawListenMediaKeys() : false), []);

  return { getVolume, setVolume, getMuted, setMuted, listenMediaKeys, ready: pluginReady() };
}
