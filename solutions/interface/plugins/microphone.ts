// @carbon/plugins/microphone — live PCM capture (Windows only for now —
// see the microphone plugin's own main.zig header comment). Does NOT
// cover device enumeration/selection, gain control, voice-activity
// detection, system-audio loopback, or any macOS/Linux equivalent.
//
// import { useMicrophone } from "@carbon/plugins/microphone";
// const { start, stop } = useMicrophone();
// start();
// carbon.on("microphone.started", ({ sampleRate, channels }) => { ... });
// carbon.on("microphone.frame", (bytes: Uint8Array) => {
//   const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
//   // interleaved by channel
// });
// stop();
//
// `start()`/`stop()` only dispatch — the actual outcome and every audio
// quantum after that arrive via `carbon.on(...)`, not this call's return
// value. See the plugin's own header comment for the full event catalog.

import { useCallback } from "react";
import { start as rawStart, stop as rawStop } from "carbon:microphone";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseMicrophoneResult {
  start: () => boolean;
  stop: () => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("start");
}

export function useMicrophone(): UseMicrophoneResult {
  const start = useCallback((): boolean => (pluginReady() ? rawStart() : false), []);
  const stop = useCallback((): boolean => (pluginReady() ? rawStop() : false), []);

  return { start, stop, ready: pluginReady() };
}
